
let utils = undefined;
let streaming = false;
let videoInput = document.getElementById('videoInput');
let canvasOutput = document.getElementById('canvasOutput');
let canvasContext = canvasOutput.getContext('2d');
let stream = null;
let cap = null;
let src = null;
let dst = null;
let gray = null;
let contours = null;
let hierarchy = null;

// Constants for Sigil Processing
const SIGIL_ROWS = 4;
const TOTAL_SUB_TRIS = 16;
// Standard Equilateral Triangle vertices (Normalized to 1.0 height)
// Top (0.5, 0), BL (0, 1), BR (1, 1) -> Assuming height=1, width=1 for simplicity in mapping?
// Better: Equilateral. H = sqrt(3)/2 * Side.
// Let's use a 200x200 canvas for the warped sigil.
const WARP_SIZE = 200;
const WARP_H = Math.floor(WARP_SIZE * Math.sqrt(3) / 2);
const WARP_XC = WARP_SIZE / 2;
const TRI_PTS = [
    { x: WARP_XC, y: 0 },            // Top
    { x: 0, y: WARP_H },             // BL
    { x: WARP_SIZE, y: WARP_H }      // BR
];

// Precompute centroids for 16 sub-triangles in the standard pose
let centroids = [];

function generateCentroids() {
    // We use barycentric coordinates logic
    // Rows 0 to 3.
    // Row 0: 1 tri.
    // Row 1: 3 tris.
    // ...
    // Coordinate system: u, v, w. u+v+w = 1.
    // Or simpler: Linear interpolation.
    // Row height = WARP_H / 4.

    let index = 0;
    const dy = WARP_H / 4;

    for (let r = 0; r < 4; r++) {
        // Row r has (2*r + 1) triangles.
        // Y range: [r*dy, (r+1)*dy]
        // Base width changes linearly.
        // Number of 'Up' triangles: r+1
        // Number of 'Down' triangles: r

        let y_top = r * dy;
        let y_bot = (r + 1) * dy;

        // Width at y_top: r * (WARP_SIZE/4) ? No.
        // Top vertex is at x=WARP_XC.
        // Width increases from 0 (at y=0 relative to top) to WARP_SIZE (at y=WARP_H).
        // x_left_edge = WARP_XC - (y / WARP_H) * (WARP_SIZE/2)
        // x_right_edge = WARP_XC + (y / WARP_H) * (WARP_SIZE/2)

        // Let's iterate through the triangles in the row from Left to Right.
        // Visualizing row 1 (index 1,2,3): 1 Up, 1 inv, 1 Up? No.
        // Row 0: 1 Up. (Index 0).
        // Row 1: Up, Down, Up. (Indices 1, 2, 3).
        // Row 2: Up, Down, Up, Down, Up. (Indices 4..8)

        // How to calculate centroids?
        // Up Triangle: (Top, BL, BR)
        // Down Triangle: (TopLeft, TopRight, Bottom)

        // We need the vertices of the grid.
        // Grid points: (r, c) where r=0..4, c=0..r.
        // v(r, c) = LERP(Top, BL, r/4) + LERP(Top, BR, r/4)? 
        // Actually: v(r, k) = P_top + (P_BL - P_top)*(r/4) + (P_BR - P_BL)*(k/4)? 
        // Let's use basis vectors. 
        // V0 = Top. V1 = BL. V2 = BR.
        // Point P = V0 + (V1-V0)*u + (V2-V0)*v, where u,v in [0,1], u+v <= 1.
        // Grid lines are u = 0, 0.25, 0.5, 0.75, 1. Same for v.
        // Small triangles are formed by grid cells.
        // Row r corresponds to (u + v) between r/4 and (r+1)/4.

        // This seems correct for "rows".
        // Let's map indices.
        // row 0: 1 tri.
        // row 1: 3 tris.

        // Implementation:
        // Iterate r from 0 to 3.
        // Iterate k (position in row) from 0 to 2*r.
        // If k is even: Up triangle.
        // If k is odd: Down triangle.

        for (let k = 0; k <= 2 * r; k++) {
            let cx, cy;
            // 'u' and 'v' approx roughly to row/col.
            // Let's just calculate centroid directly in X,Y.

            // Y Centroid:
            // Up Tri: 2/3 down from top of row. y = y_top + dy * (2/3).
            // Down Tri: 1/3 down from top of row. y = y_top + dy * (1/3).

            let isUp = (k % 2 === 0);

            if (isUp) {
                cy = y_top + dy * (2 / 3);
            } else {
                cy = y_top + dy * (1 / 3);
            }

            // X Centroid:
            // Row r, k-th triangle.
            // Center of the row at height cy is WARP_XC.
            // Width of the row at this height: W_row = WARP_SIZE * (cy / WARP_H).
            // Left edge X: WARP_XC - W_row / 2.

            // Simpler approach:
            // The base of row r has (r+1) Up triangles.
            // The width of each small triangle base is (WARP_SIZE / 4).
            // Let w_tri = WARP_SIZE / 4.
            // Center X of first Up triangle in row r?
            // Row 0: Center 0.
            // Row 1: Center -0.5*w, Center 0 (Down), Center +0.5*w.
            // Let's interpret 'k'.
            // k=0 -> Leftmost Up.
            // k=1 -> First Down.
            // k=2 -> Second Up.

            // X coord of 'Up' triangle centroid at col `i` (where k=2*i):
            // Center of row 0: WARP_XC.
            // Center of row 1 (Left Up): WARP_XC - w_tri/2.
            // Center of row 1 (Right Up): WARP_XC + w_tri/2.
            // Gap is w_tri.

            // General Formula:
            // Center of row r (geometric center of the array of triangles): WARP_XC.
            // Total span of centroids in row r?
            // Row 0: 1 pt. Span 0.
            // Row 1: 3 pts. -0.5w, 0, +0.5w (relative to center).
            // Row 2: 5 pts. -1.0w, -0.5w, 0, 0.5w, 1.0w.
            // Spacing is w_tri / 2.

            let w_tri = WARP_SIZE / 4;
            let offset_from_center = (k - r) * (w_tri / 2);
            cx = WARP_XC + offset_from_center;

            centroids.push({ x: cx, y: cy, index: index });
            index++;
        }
    }
}

// Global bit map rotation cache
let rotationMaps = {}; // {0: [0..15], 1: [rotated], 2: [rotated]}  0=0deg, 1=120, 2=240

function generateRotationMaps() {
    // 0 deg
    rotationMaps[0] = Array.from({ length: 16 }, (_, i) => i);

    // 120 deg (Clockwise)
    // Transform centroids by Rotating -120 deg around CENTER of Main Triangle.
    // Center of Main Triangle: (WARP_XC, WARP_H * 2/3). (Centroid of equilateral).
    let cx = WARP_XC;
    let cy = WARP_H * (2 / 3);

    function getMap(angleRad) {
        let map = new Array(16);
        for (let i = 0; i < 16; i++) {
            let p = centroids[i];
            // Rotate p around (cx, cy)
            let dx = p.x - cx;
            let dy = p.y - cy;
            let rx = dx * Math.cos(angleRad) - dy * Math.sin(angleRad);
            let ry = dx * Math.sin(angleRad) + dy * Math.cos(angleRad);
            let finalX = rx + cx;
            let finalY = ry + cy;

            // Find nearest centroid index
            let bestIdx = -1;
            let minDist = Infinity;
            for (let j = 0; j < 16; j++) {
                let p2 = centroids[j];
                let d = (p2.x - finalX) ** 2 + (p2.y - finalY) ** 2;
                if (d < minDist) {
                    minDist = d;
                    bestIdx = j;
                }
            }
            map[i] = bestIdx;
        }
        return map;
    }

    rotationMaps[1] = getMap(2 * Math.PI / 3);  // 120 deg
    rotationMaps[2] = getMap(4 * Math.PI / 3);  // 240 deg
}


function onOpenCvReady() {
    cv['onRuntimeInitialized'] = () => {
        document.getElementById('status-text').innerHTML = "Camera Starting...";
        startCamera();
        generateCentroids();
        generateRotationMaps();
    };
}

function startCamera() {
    navigator.mediaDevices.getUserMedia({
        video: {
            facingMode: 'environment',
            width: { ideal: 1280 }, // Higher res for better detection
            height: { ideal: 720 }
        },
        audio: false
    })
        .then(function (s) {
            stream = s;
            videoInput.srcObject = stream;
            videoInput.play();
        })
        .catch(function (err) {
            console.log("An error occurred! " + err);
            document.getElementById('status-text').innerHTML = "Camera Error";
        });

    videoInput.onloadedmetadata = function (e) {
        document.getElementById('status-text').innerHTML = "System Ready";
        videoInput.width = videoInput.videoWidth;
        videoInput.height = videoInput.videoHeight;
        cap = new cv.VideoCapture(videoInput);

        src = new cv.Mat(videoInput.height, videoInput.width, cv.CV_8UC4);
        gray = new cv.Mat();
        dst = new cv.Mat(); // For rendering

        requestAnimationFrame(processVideo);
    };
}

function processVideo() {
    try {
        if (!streaming) {
            // clean up
            if (src) src.delete();
            if (gray) gray.delete();
            if (dst) dst.delete();
            return;
        }

        let begin = Date.now();

        cap.read(src);
        src.copyTo(dst); // Draw on dst


        // Schedule next frame
        let delay = 1000 / 30 - (Date.now() - begin);
        requestAnimationFrame(processVideo);

    } catch (err) {
        console.error(err);
    }
}

function decodeSigil(trianglePts, imageMat) {
    // 1. Sort Vertices
    // We need a consistent order to map to our Canonical Triangle.
    // Let's sort by Y first to find Top?
    // Actually, due to rotation, 'Top' might be anywhere.
    // Sorting by Y helps to just have a deterministic warp.
    // We will handle rotation logic on the bits.

    trianglePts.sort((a, b) => a.y - b.y);
    // Determine Top, Left, Right based on remaining
    // Actually, just sorting by Y gives P0 (Top-ish). P1, P2 are bottom.
    // Sort P1, P2 by X.
    if (trianglePts[1].x > trianglePts[2].x) {
        let tmp = trianglePts[1];
        trianglePts[1] = trianglePts[2];
        trianglePts[2] = tmp;
    }
    // Now we have: Top(P0), BL(P1), BR(P2). (Roughly).
    // This allows us to warp to our canonical Top(0), BL(9), BR(15).

    // 2. Warp Perspective/Affine
    let srcTri = cv.matFromArray(3, 1, cv.CV_32FC2, [
        trianglePts[0].x, trianglePts[0].y,
        trianglePts[1].x, trianglePts[1].y,
        trianglePts[2].x, trianglePts[2].y
    ]);

    // Destination: Fixed equilateral triangle
    let dstTri = cv.matFromArray(3, 1, cv.CV_32FC2, [
        TRI_PTS[0].x, TRI_PTS[0].y,
        TRI_PTS[1].x, TRI_PTS[1].y,
        TRI_PTS[2].x, TRI_PTS[2].y
    ]);

    let M = cv.getAffineTransform(srcTri, dstTri);
    let warped = new cv.Mat();
    let dsize = new cv.Size(WARP_SIZE, WARP_SIZE + 20); // Height is ~173.
    cv.warpAffine(gray, warped, M, dsize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

    // 3. Sample 16 Points
    let samples = []; // 0 to 255
    let bits = [];    // 0 or 1

    for (let i = 0; i < 16; i++) {
        let p = centroids[i];
        if (p.x < 0 || p.x >= warped.cols || p.y < 0 || p.y >= warped.rows) {
            samples.push(0);
        } else {
            let pixel = warped.ucharAt(Math.floor(p.y), Math.floor(p.x));
            samples.push(pixel);
        }
    }

    // 4. Threshold Bits
    // Dynamic Median:
    let sorted = [...samples].sort((a, b) => a - b);
    let median = sorted[8]; // roughly middle

    // Threshold
    for (let i = 0; i < 16; i++) {
        // Darker than median? -> 1 (Black). Lighter? -> 0 (White).
        // Adjust threshold slightly?
        let val = (samples[i] < median) ? 1 : 0;
        bits.push(val);
    }

    // 5. Check Orientation
    // Anchors indices: 0, 9, 15.
    // "Two of the three ... are always black (1)."
    // We check all 3 rotations: 0, 120, 240.

    let validRotation = -1;
    let finalBits = null;
    let blackVertices = [];

    for (let rot = 0; rot < 3; rot++) {
        let map = rotationMaps[rot];
        let anchorsSum = 0;

        // Mapped indices of corners:
        // Corner 0 maps to map[0]... wait.
        // If we apply rotation 'rot', the bit at Index `i` in the *canonical* payload
        // comes from Index `map[i]` in the *scanned* bits.
        // Wait, rotation map transforms index `i` to `j`.
        // Does `j` represent the source or destination?
        // My generateRotationMaps maps `i` (canonical) -> `j` (rotated).
        // e.g. If rotated 120deg, Index 0 (Top) moves to Index 15 (BR).
        // So the bit at Index 15 in the scan IS the Top bit (Index 0).
        // So Canonical[0] = Scanned[15].
        // So Canonical[i] = Scanned[Map[i]].

        // Let's check anchors in the Canonical frame.
        // Indices 0, 9, 15.
        // Check if Sum(Canonical[0], Canonical[9], Canonical[15]) == 2.

        let c0 = bits[map[0]];
        let c9 = bits[map[9]];
        let c15 = bits[map[15]];

        if (c0 + c9 + c15 === 2) {
            validRotation = rot;
            // Decode full payload
            finalBits = [];
            for (let k = 0; k < 16; k++) {
                finalBits.push(bits[map[k]]);
            }
            // Which one is the white one?
            // "The logic identifies... remaps... to align with a Logical Top".
            // The mapping IS the remapping.
            break;
        }
    }

    // Cleanup
    srcTri.delete(); dstTri.delete(); M.delete(); warped.delete();

    if (validRotation !== -1) {
        return {
            bits: finalBits,
            raw: bits,
            rotation: validRotation
        };
    }

    return null;
}

function updateUI(result) {
    let bits = result.bits;
    // Update bit grid
    let grid = document.getElementById('bit-grid');
    grid.innerHTML = '';

    let idVal = 0;

    for (let i = 0; i < 16; i++) {
        let div = document.createElement('div');
        div.className = 'bit ' + (bits[i] ? 'one' : 'zero');
        div.innerText = i; // bits[i];
        grid.appendChild(div);

        // Calculate ID? 
        // 9 data bits. Which are they?
        // Assuming undefined schema, just showing bits.
    }

    let dbg = document.getElementById('debug-panel');
    dbg.style.display = 'block';

    document.getElementById('status-text').innerHTML = "SCAN DETECTED";
    document.getElementById('status-dot').className = "status-dot active";
}

// Start
streaming = true;
// Load OpenCV
// Assuming script loaded in HTML
