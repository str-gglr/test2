// ============================================================
//  SIGIL SCANNER — script.js
//  Decodes a 16-cell equilateral-triangle sigil from live video.
// ============================================================

// ===== GLOBALS =====
let streaming = true;
let videoInput, canvasOutput;
let stream = null;
let cap = null;
let src = null, dst = null, gray = null;

// ===== WARP TARGET: canonical equilateral triangle =====
const WARP_SIZE = 200;
const WARP_H = Math.floor(WARP_SIZE * Math.sqrt(3) / 2); // ~173
const WARP_XC = WARP_SIZE / 2;                             // 100
const TRI_PTS = [
    { x: WARP_XC, y: 0 },  // Top
    { x: 0, y: WARP_H },  // Bottom-Left
    { x: WARP_SIZE, y: WARP_H }   // Bottom-Right
];

// ===== PRE-COMPUTED DATA =====
let centroids = [];   // 16 centroid positions in canonical warp space
let rotationMaps = {};   // 0 → identity,  1 → 120°,  2 → 240°

// ===== BIT LAYOUT (canonical, after rotation alignment) =====
// Row 1: Index 0 = Black Anchor
// Row 2: Index 1=D1, 2=P1, 3=D2
// Row 3: Index 4=D3, 5=D4, 6=P2, 7=D5, 8=D6
// Row 4: Index 9=Black Anchor, 10=P3, 11=D7, 12=D8, 13=D9, 14=P4, 15=White Anchor

const ANCHOR_INDICES = [0, 9];
const SYNC_INDEX = 15;
const DATA_INDICES = [1, 3, 4, 5, 7, 8, 11, 12, 13];  // D1-D9 in order
const PARITY_INDICES = [2, 6, 10, 14];                    // P1-P4 in order

// Exact parity formulas from the generator:
// P1 (S1) = D1 ⊕ D2 ⊕ D4 ⊕ D5 ⊕ D7 ⊕ D9  (dataBits indices: 0,1,3,4,6,8)
// P2 (S2) = D3 ⊕ D4 ⊕ D5 ⊕ D6 ⊕ D8 ⊕ D9  (dataBits indices: 2,3,4,5,7,8)
// P3 (S3) = D1 ⊕ D3 ⊕ D4 ⊕ D7 ⊕ D8       (dataBits indices: 0,2,3,6,7)
// P4 (S4) = D2 ⊕ D5 ⊕ D6 ⊕ D8 ⊕ D9       (dataBits indices: 1,4,5,7,8)
const PARITY_FORMULAS = [
    [0, 1, 3, 4, 6, 8],  // P1
    [2, 3, 4, 5, 7, 8],  // P2
    [0, 2, 3, 6, 7],     // P3
    [1, 4, 5, 7, 8]      // P4
];

// ===== MULTI-FRAME CONFIRMATION STATE =====
const CONFIRM_NEEDED = 3;     // consecutive identical reads required
let lastSeenId = -1;
let confirmCount = 0;
let lockedId = -1;
let lockTimer = null;

// Sampling radius around each centroid (pixels in warp space)
const SAMPLE_RADIUS = 5;

// ============================================================
//  CENTROID GENERATION
//  Rows 0–3 → 1, 3, 5, 7 sub-triangles  (total 16).
//  Even k → upward ▲,  odd k → inverted ▽.
// ============================================================
function generateCentroids() {
    centroids = [];
    const dy = WARP_H / 4;
    let idx = 0;

    for (let r = 0; r < 4; r++) {
        const yTop = r * dy;
        for (let k = 0; k <= 2 * r; k++) {
            const isUp = (k % 2 === 0);
            const cy = isUp ? yTop + dy * (2 / 3) : yTop + dy * (1 / 3);
            const wTri = WARP_SIZE / 4;
            const cx = WARP_XC + (k - r) * (wTri / 2);
            centroids.push({ x: cx, y: cy, index: idx });
            idx++;
        }
    }
    console.log('Generated centroids:', centroids);
}

// ============================================================
//  ROTATION MAP GENERATION
//  Rotates each centroid 120° / 240° around the triangle's
//  geometric centre, then finds the nearest canonical centroid.
// ============================================================
function generateRotationMaps() {
    rotationMaps[0] = Array.from({ length: 16 }, (_, i) => i);

    const cx = WARP_XC;
    const cy = WARP_H * (2 / 3);   // centroid of equilateral triangle

    function buildMap(angleRad) {
        const map = new Array(16);
        for (let i = 0; i < 16; i++) {
            const p = centroids[i];
            const dx = p.x - cx;
            const dy = p.y - cy;
            const rx = dx * Math.cos(angleRad) - dy * Math.sin(angleRad) + cx;
            const ry = dx * Math.sin(angleRad) + dy * Math.cos(angleRad) + cy;

            let best = -1, bestD = Infinity;
            for (let j = 0; j < 16; j++) {
                const d = (centroids[j].x - rx) ** 2 + (centroids[j].y - ry) ** 2;
                if (d < bestD) { bestD = d; best = j; }
            }
            map[i] = best;
        }
        return map;
    }

    rotationMaps[1] = buildMap(2 * Math.PI / 3);   // 120°
    rotationMaps[2] = buildMap(4 * Math.PI / 3);    // 240°

    console.log('Rotation maps:', rotationMaps);
}

// ============================================================
//  SAMPLE REGION
//  Average luminance in a NxN patch around a centroid.
//  Much more robust than a single-pixel read on noisy images.
// ============================================================
function sampleRegion(mat, px, py, radius) {
    let sum = 0, n = 0;
    const r = radius || SAMPLE_RADIUS;
    const xc = Math.round(px);
    const yc = Math.round(py);

    for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
            const x = xc + dx;
            const y = yc + dy;
            if (x >= 0 && x < mat.cols && y >= 0 && y < mat.rows) {
                sum += mat.ucharAt(y, x);
                n++;
            }
        }
    }
    return n > 0 ? sum / n : 128;
}

// ============================================================
//  OPENCV INIT
// ============================================================
function onOpenCvReady() {
    console.log('OpenCV Ready');
    document.getElementById('status-text').textContent = 'Camera Starting…';
    try {
        generateCentroids();
        generateRotationMaps();
        startCamera();
    } catch (e) {
        console.error('Init error:', e);
        document.getElementById('status-text').textContent = 'Init Error';
    }
}

// ============================================================
//  CAMERA
// ============================================================
function startCamera() {
    console.log('startCamera');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.error('getUserMedia unavailable (need HTTPS or localhost)');
        document.getElementById('status-text').textContent = 'Camera Not Supported';
        return;
    }

    videoInput = document.getElementById('videoInput');
    canvasOutput = document.getElementById('canvasOutput');

    // Register handler BEFORE the stream arrives
    videoInput.onloadedmetadata = function () {
        console.log('Video ready:', videoInput.videoWidth, '×', videoInput.videoHeight);
        document.getElementById('status-text').textContent = 'Scanning…';
        document.getElementById('status-dot').className = 'status-dot active';

        videoInput.width = videoInput.videoWidth;
        videoInput.height = videoInput.videoHeight;
        canvasOutput.width = videoInput.videoWidth;
        canvasOutput.height = videoInput.videoHeight;

        cap = new cv.VideoCapture(videoInput);
        src = new cv.Mat(videoInput.height, videoInput.width, cv.CV_8UC4);
        gray = new cv.Mat();
        dst = new cv.Mat();

        requestAnimationFrame(processVideo);
    };

    navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
    })
        .then(function (s) {
            console.log('Camera stream acquired');
            stream = s;
            videoInput.srcObject = stream;
            videoInput.play();
        })
        .catch(function (err) {
            console.error('Camera error:', err);
            document.getElementById('status-text').textContent = 'Camera Error: ' + err.message;
            document.getElementById('status-dot').className = 'status-dot error';
        });
}

// ============================================================
//  MAIN LOOP
// ============================================================
function processVideo() {
    try {
        if (!streaming) {
            if (src) src.delete();
            if (gray) gray.delete();
            if (dst) dst.delete();
            return;
        }

        cap.read(src);
        src.copyTo(dst);
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

        // --- Binarise for contour detection ---
        let blurred = new cv.Mat();
        let binary = new cv.Mat();
        cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
        cv.adaptiveThreshold(blurred, binary, 255,
            cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 21, 5);
        blurred.delete();

        let contours = new cv.MatVector();
        let hierarchy = new cv.Mat();
        cv.findContours(binary, contours, hierarchy,
            cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);
        binary.delete();

        // --- Find the LARGEST valid triangle ---
        let bestResult = null;
        let bestArea = 0;
        let bestContourIdx = -1;

        for (let i = 0; i < contours.size(); i++) {
            const cnt = contours.get(i);
            const area = cv.contourArea(cnt);
            if (area < 3000 || area <= bestArea) continue;

            const peri = cv.arcLength(cnt, true);
            const approx = new cv.Mat();
            cv.approxPolyDP(cnt, approx, 0.04 * peri, true);

            if (approx.rows === 3 && cv.isContourConvex(approx)) {
                const pts = [];
                for (let j = 0; j < 3; j++) {
                    pts.push({
                        x: approx.data32S[j * 2],
                        y: approx.data32S[j * 2 + 1]
                    });
                }

                const result = decodeSigil(pts);
                if (result) {
                    bestResult = result;
                    bestArea = area;
                    bestContourIdx = i;
                }
            }
            approx.delete();
        }

        // --- Draw result & update UI ---
        if (bestResult && bestContourIdx >= 0) {
            const green = new cv.Scalar(0, 255, 157, 255);
            cv.drawContours(dst, contours, bestContourIdx, green, 3,
                cv.LINE_8, hierarchy, 0);
            handleDetection(bestResult);
        } else if (lockedId < 0) {
            document.getElementById('status-text').textContent = 'Scanning…';
        }

        cv.imshow('canvasOutput', dst);
        contours.delete();
        hierarchy.delete();
    } catch (err) {
        console.error('processVideo:', err);
    }

    requestAnimationFrame(processVideo);
}

// ============================================================
//  DECODE SIGIL
// ============================================================
function decodeSigil(triPts) {
    // 1. Sort vertices: top-most first, then left-before-right for bottom pair
    triPts.sort((a, b) => a.y - b.y);
    if (triPts[1].x > triPts[2].x) {
        [triPts[1], triPts[2]] = [triPts[2], triPts[1]];
    }

    // 2. Affine warp
    const srcTri = cv.matFromArray(3, 1, cv.CV_32FC2, [
        triPts[0].x, triPts[0].y,
        triPts[1].x, triPts[1].y,
        triPts[2].x, triPts[2].y
    ]);
    const dstTri = cv.matFromArray(3, 1, cv.CV_32FC2, [
        TRI_PTS[0].x, TRI_PTS[0].y,
        TRI_PTS[1].x, TRI_PTS[1].y,
        TRI_PTS[2].x, TRI_PTS[2].y
    ]);
    const M = cv.getAffineTransform(srcTri, dstTri);
    const warped = new cv.Mat();
    const dsize = new cv.Size(WARP_SIZE + 1, WARP_H + 1);
    cv.warpAffine(gray, warped, M, dsize,
        cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(128));

    // 3. Sample all 16 centroids with area averaging
    const lum = [];
    for (let i = 0; i < 16; i++) {
        lum.push(sampleRegion(warped, centroids[i].x, centroids[i].y, SAMPLE_RADIUS));
    }

    // 4. Try all 3 rotations
    let bestResult = null;
    let bestContrast = 0;

    for (let rot = 0; rot < 3; rot++) {
        const map = rotationMaps[rot];

        // Map raw luminance into canonical frame
        const canon = new Array(16);
        for (let i = 0; i < 16; i++) canon[i] = lum[map[i]];

        // Anchor / Sync luminance
        const a1Lum = canon[ANCHOR_INDICES[0]];   // index 0
        const a2Lum = canon[ANCHOR_INDICES[1]];   // index 9
        const syncLum = canon[SYNC_INDEX];           // index 15

        // Anchors must be darker than sync
        if (a1Lum >= syncLum || a2Lum >= syncLum) continue;

        const darkRef = (a1Lum + a2Lum) / 2;       // average black
        const lightRef = syncLum;                     // white reference
        const contrast = lightRef - darkRef;

        // Reject low-contrast (noisy / bad frame)
        if (contrast < 30) continue;

        // Adaptive threshold: midpoint of calibrated scale
        const thresh = darkRef + contrast * 0.5;

        // Classify all 16 bits: darker-than-threshold → 1 (black)
        const bits = new Array(16);
        for (let i = 0; i < 16; i++) {
            bits[i] = (canon[i] < thresh) ? 1 : 0;
        }

        // Verify structural constraints
        if (bits[ANCHOR_INDICES[0]] !== 1) continue;   // anchor must be black
        if (bits[ANCHOR_INDICES[1]] !== 1) continue;
        if (bits[SYNC_INDEX] !== 0) continue;   // sync must be white

        // Extract data & parity
        const dataBits = DATA_INDICES.map(i => bits[i]);
        const parityBits = PARITY_INDICES.map(i => bits[i]);

        // Compute ID from 9 data bits (MSB-first → 0…511)
        let id = 0;
        for (let i = 0; i < 9; i++) id = (id << 1) | dataBits[i];

        // Parity validation
        let parityOk = true;
        for (let p = 0; p < 4; p++) {
            let expected = 0;
            for (const idx of PARITY_FORMULAS[p]) {
                expected ^= dataBits[idx];
            }
            if (expected !== parityBits[p]) {
                parityOk = false;
                break;
            }
        }

        console.log('Rot ' + (rot * 120) + '° - ID: ' + id +
            ' - Parity: ' + (parityOk ? 'PASS ✓' : 'FAIL ✗') +
            ' - Bits: ' + bits.join('') +
            ' - Data: ' + dataBits.join('') +
            ' - Contrast: ' + Math.round(contrast));

        // Skip if parity fails
        if (!parityOk) continue;

        // Keep the decode with the highest contrast (best quality)
        if (contrast > bestContrast) {
            bestContrast = contrast;
            bestResult = {
                id,
                bits,
                dataBits,
                parityBits,
                rotation: rot * 120,
                contrast: Math.round(contrast),
                darkRef: Math.round(darkRef),
                lightRef: Math.round(lightRef)
            };
        }
    }

    // Cleanup OpenCV mats
    srcTri.delete();
    dstTri.delete();
    M.delete();
    warped.delete();

    return bestResult;
}

// ============================================================
//  MULTI-FRAME CONFIRMATION
// ============================================================
function handleDetection(result) {
    if (result.id === lastSeenId) {
        confirmCount++;
    } else {
        lastSeenId = result.id;
        confirmCount = 1;
    }

    if (confirmCount >= CONFIRM_NEEDED) {
        lockedId = result.id;
        updateUI(result, true);

        // Auto-unlock after 5 s
        if (lockTimer) clearTimeout(lockTimer);
        lockTimer = setTimeout(() => {
            lockedId = -1;
            lastSeenId = -1;
            confirmCount = 0;
            document.getElementById('debug-panel').style.display = 'none';
            document.getElementById('id-display').className = 'id-display';
            document.getElementById('id-value').textContent = '---';
            document.getElementById('status-text').textContent = 'Scanning…';
            document.getElementById('status-dot').className = 'status-dot active';
        }, 5000);
    } else {
        updateUI(result, false);
    }
}

// ============================================================
//  UI UPDATE
// ============================================================
function updateUI(result, confirmed) {
    const bits = result.bits;

    // --- Bit grid ---
    const grid = document.getElementById('bit-grid');
    grid.innerHTML = '';
    for (let i = 0; i < 16; i++) {
        const cell = document.createElement('div');
        // Determine role for colour-coding
        let role = 'data';
        if (ANCHOR_INDICES.includes(i)) role = 'anchor';
        else if (i === SYNC_INDEX) role = 'sync';
        else if (PARITY_INDICES.includes(i)) role = 'parity';

        cell.className = 'bit '
            + (bits[i] ? 'one' : 'zero') + ' '
            + role;
        cell.textContent = bits[i];
        grid.appendChild(cell);
    }

    // --- ID display ---
    const idStr = String(result.id).padStart(3, '0');
    document.getElementById('id-value').textContent = idStr;

    const idDisplay = document.getElementById('id-display');
    idDisplay.className = confirmed ? 'id-display confirmed' : 'id-display pending';

    // --- Meta info ---
    document.getElementById('meta-info').innerHTML =
        'ROT ' + result.rotation + '°  · CONTRAST ' + result.contrast +
        '  · DARK ' + result.darkRef + ' / LIGHT ' + result.lightRef;

    document.getElementById('parity-status').textContent =
        'PARITY: PASS ✓';
    document.getElementById('parity-status').className = 'parity-pass';

    // --- Status bar ---
    document.getElementById('status-dot').className =
        confirmed ? 'status-dot locked' : 'status-dot active';
    document.getElementById('status-text').textContent =
        confirmed ? 'ID LOCKED' : 'CONFIRMING ' + confirmCount + '/' + CONFIRM_NEEDED + '…';

    // --- Show panel ---
    document.getElementById('debug-panel').style.display = 'block';
}
