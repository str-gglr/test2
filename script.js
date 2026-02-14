
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
    let index = 0;
    const dy = WARP_H / 4;

    for (let r = 0; r < 4; r++) {
        let y_top = r * dy;
        let y_bot = (r + 1) * dy;

        for (let k = 0; k <= 2 * r; k++) {
            let cx, cy;
            let isUp = (k % 2 === 0);

            if (isUp) {
                cy = y_top + dy * (2 / 3);
            } else {
                cy = y_top + dy * (1 / 3);
            }

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
    let cx = WARP_XC;
    let cy = WARP_H * (2 / 3);

    function getMap(angleRad) {
        let map = new Array(16);
        for (let i = 0; i < 16; i++) {
            let p = centroids[i];
            let dx = p.x - cx;
            let dy = p.y - cy;
            let rx = dx * Math.cos(angleRad) - dy * Math.sin(angleRad);
            let ry = dx * Math.sin(angleRad) + dy * Math.cos(angleRad);
            let finalX = rx + cx;
            let finalY = ry + cy;

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
    console.log("OpenCV Ready - Starting Camera");
    document.getElementById('status-text').innerHTML = "Camera Starting...";
    // Ensure functions are called safely
    try {
        startCamera();
        generateCentroids();
        generateRotationMaps();
    } catch (e) {
        console.error("Initialization Error:", e);
        document.getElementById('status-text').innerHTML = "Init Error";
    }
}

function startCamera() {
    navigator.mediaDevices.getUserMedia({
        video: {
            facingMode: 'environment',
            width: { ideal: 1280 },
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
            if (src) src.delete();
            if (gray) gray.delete();
            if (dst) dst.delete();
            return;
        }

        let begin = Date.now();

        cap.read(src);
        src.copyTo(dst);
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

        // Find Contours
        let contours = new cv.MatVector();
        let hierarchy = new cv.Mat();
        // Use gray for contours? Better to use binary.
        let binary = new cv.Mat();
        cv.adaptiveThreshold(gray, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 21, 5);
        cv.findContours(binary, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);
        binary.delete();

        let foundSigil = false;

        for (let i = 0; i < contours.size(); ++i) {
            let cnt = contours.get(i);
            let area = cv.contourArea(cnt);

            if (area < 2000) continue;

            let peri = cv.arcLength(cnt, true);
            let approx = new cv.Mat();
            cv.approxPolyDP(cnt, approx, 0.04 * peri, true);

            if (approx.rows === 3 && cv.isContourConvex(approx)) {
                let color = new cv.Scalar(0, 255, 0, 255);

                let pts = [];
                for (let j = 0; j < 3; j++) {
                    pts.push({
                        x: approx.data32S[j * 2],
                        y: approx.data32S[j * 2 + 1]
                    });
                }

                let result = decodeSigil(pts, gray);

                if (result) {
                    foundSigil = true;
                    cv.drawContours(dst, contours, i, color, 3, cv.LINE_8, hierarchy, 0);
                    updateUI(result);
                }
            }
            approx.delete();
        }

        cv.imshow('canvasOutput', dst);

        contours.delete();
        hierarchy.delete();

        let delay = 1000 / 30 - (Date.now() - begin);
        requestAnimationFrame(processVideo);

    } catch (err) {
        console.error(err);
    }
}

function decodeSigil(trianglePts, imageMat) {
    trianglePts.sort((a, b) => a.y - b.y);
    if (trianglePts[1].x > trianglePts[2].x) {
        let tmp = trianglePts[1];
        trianglePts[1] = trianglePts[2];
        trianglePts[2] = tmp;
    }

    let srcTri = cv.matFromArray(3, 1, cv.CV_32FC2, [
        trianglePts[0].x, trianglePts[0].y,
        trianglePts[1].x, trianglePts[1].y,
        trianglePts[2].x, trianglePts[2].y
    ]);

    let dstTri = cv.matFromArray(3, 1, cv.CV_32FC2, [
        TRI_PTS[0].x, TRI_PTS[0].y,
        TRI_PTS[1].x, TRI_PTS[1].y,
        TRI_PTS[2].x, TRI_PTS[2].y
    ]);

    let M = cv.getAffineTransform(srcTri, dstTri);
    let warped = new cv.Mat();
    let dsize = new cv.Size(WARP_SIZE, WARP_SIZE + 20);
    cv.warpAffine(gray, warped, M, dsize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

    let samples = [];
    let bits = [];

    for (let i = 0; i < 16; i++) {
        let p = centroids[i];
        if (p.x < 0 || p.x >= warped.cols || p.y < 0 || p.y >= warped.rows) {
            samples.push(0);
        } else {
            let pixel = warped.ucharAt(Math.floor(p.y), Math.floor(p.x));
            samples.push(pixel);
        }
    }

    let sorted = [...samples].sort((a, b) => a - b);
    let median = sorted[8];

    for (let i = 0; i < 16; i++) {
        let val = (samples[i] < median) ? 1 : 0;
        bits.push(val);
    }

    let validRotation = -1;
    let finalBits = null;

    for (let rot = 0; rot < 3; rot++) {
        let map = rotationMaps[rot];
        let c0 = bits[map[0]];
        let c9 = bits[map[9]];
        let c15 = bits[map[15]];

        if (c0 + c9 + c15 === 2) {
            validRotation = rot;
            finalBits = [];
            for (let k = 0; k < 16; k++) {
                finalBits.push(bits[map[k]]);
            }
            break;
        }
    }

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
    let grid = document.getElementById('bit-grid');
    grid.innerHTML = '';

    for (let i = 0; i < 16; i++) {
        let div = document.createElement('div');
        div.className = 'bit ' + (bits[i] ? 'one' : 'zero');
        div.innerText = i;
        grid.appendChild(div);
    }

    let dbg = document.getElementById('debug-panel');
    dbg.style.display = 'block';

    document.getElementById('status-text').innerHTML = "SCAN DETECTED";
    document.getElementById('status-dot').className = "status-dot active";
}

streaming = true;
