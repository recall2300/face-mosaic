/**
 * 페이스 모자이크 - 얼굴 자동 마스킹 웹앱
 * face-api.js 기반 클라이언트 사이드 처리
 *
 * v2: 치명적 버그 수정(단일 저장+모자이크 미적용) 및 전면 리팩터링
 * - 픽셀 마스크 3중복 함수 → drawPixelMosaic 하나로 통합
 * - 이모지 마스크 2중복 함수 → drawEmojiMask 하나로 통합
 * - 블러 / 블랙바 마스크 스타일 추가
 * - 수동 영역 지정 모드 추가
 * - 모델·라이브러리·폰트 완전 로컬화 (서드파티 요청 제거)
 */

// ===================================
// 상수
// ===================================
const MAX_FILE_SIZE = 20 * 1024 * 1024;   // 20MB (UI 문구와 일치)
const MAX_FILE_COUNT = 50;                // 한 번에 처리할 최대 장수
const MAX_DETECT_SIZE = 1024;             // 감지용 리사이즈 상한
const MAX_OUTPUT_MEGAPIXELS = 16;         // 저장 이미지 상한 (iOS Safari 캔버스 제한 고려)

// 모델은 로컬(models/) 우선, 실패 시 CDN 폴백
const MODEL_URLS = [
  'models',
  'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/weights',
  'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights',
];

// ===================================
// 상태 관리
// ===================================
const state = {
  modelsLoaded: false,
  images: [],               // { id, name, objectUrl, naturalW, naturalH, faces: [], status: 'loading'|'done' }
  currentIndex: -1,         // 현재 보고 있는 이미지 인덱스
  maskStyle: 'mosaic',      // 'mosaic' | 'blur' | 'blackbar' | 이모지 문자열
  manualMode: false,        // 수동 영역 지정 모드
  faceSeq: 0,               // 얼굴/이미지 고유 id 발급용 시퀀스
  // 현재 활성화된 이미지의 렌더링용 임시 값들
  scaleX: 1,
  scaleY: 1,
};

// 수동 드래그 상태 (모듈 스코프)
let dragStart = null;       // {x, y} display 좌표
let dragRect = null;        // {x, y, w, h} display 좌표 (미리보기용)

// ===================================
// DOM 참조
// ===================================
const $ = id => document.getElementById(id);
const uploadSection   = $('uploadSection');
const processingSection = $('processingSection');
const uploadZone      = $('uploadZone');
const fileInput       = $('fileInput');
const sourceImage     = $('sourceImage');
const maskCanvas      = $('maskCanvas');
const scanLine        = $('scanLine');
const loadingOverlay  = $('loadingOverlay');
const loadingText     = $('loadingText');
const facesPanel      = $('facesPanel');
const facesGrid       = $('facesGrid');
const facesCount      = $('facesCount');
const noFaces         = $('noFaces');
const newImageBtn     = $('newImageBtn');
const rescanBtn       = $('rescanBtn');
const manualAddBtn    = $('manualAddBtn');
const downloadBtn     = $('downloadBtn');
const downloadAllBtn  = $('downloadAllBtn');
const maskAllBtn      = $('maskAllBtn');
const unmaskAllBtn    = $('unmaskAllBtn');
const styleOptions    = $('styleOptions');
const styleOpts       = document.querySelectorAll('.style-opt');
const imageQueue      = $('imageQueue');
const queueList       = $('queueList');
const queueCount      = $('queueCount');

// ===================================
// 초기화
// ===================================
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  // 모델은 사진 선택 시 로드 (지연 로딩)
});

function setupEventListeners() {
  // 업로드 드래그 앤 드롭
  uploadZone.addEventListener('dragover', e => {
    e.preventDefault();
    uploadZone.classList.add('drag-over');
  });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
  uploadZone.addEventListener('drop', e => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) handleFiles(files);
    else showToast('이미지 파일만 지원됩니다.', 'error');
  });

  // uploadZone 클릭 - 버튼 클릭은 제외 (버블링 방지)
  uploadZone.addEventListener('click', e => {
    if (e.target.closest('#selectBtn')) return; // 버튼에서 온 이벤트는 무시
    fileInput.click();
  });

  // 사진 선택하기 버튼 - 버블링 차단
  const selectBtn = $('selectBtn');
  selectBtn.addEventListener('click', e => {
    e.stopPropagation(); // uploadZone 클릭 이벤트 버블링 차단
    fileInput.click();
  });

  fileInput.addEventListener('change', e => {
    const files = Array.from(e.target.files);
    e.target.value = ''; // 같은 파일 재선택 가능하도록 초기화
    if (files.length > 0) handleFiles(files);
  });

  // 버튼들
  newImageBtn.addEventListener('click', resetToUpload);
  rescanBtn.addEventListener('click', () => detectFaces());
  manualAddBtn.addEventListener('click', toggleManualMode);
  downloadBtn.addEventListener('click', downloadMaskedImage);
  downloadAllBtn.addEventListener('click', downloadAllImages);
  maskAllBtn.addEventListener('click', () => setAllMasks(true));
  unmaskAllBtn.addEventListener('click', () => setAllMasks(false));

  // 수동 영역 지정용 캔버스 드래그
  maskCanvas.addEventListener('pointerdown', e => {
    if (!state.manualMode || state.currentIndex === -1) return;
    e.preventDefault();
    dragStart = canvasPointerPos(e);
    dragRect = null;
  });
  maskCanvas.addEventListener('pointermove', e => {
    if (!dragStart) return;
    dragRect = normRect(dragStart, canvasPointerPos(e));
    applyMasks();
  });
  window.addEventListener('pointerup', e => {
    if (!dragStart) return;
    const rect = normRect(dragStart, canvasPointerPos(e));
    dragStart = null;
    dragRect = null;
    if (rect.w < 12 || rect.h < 12) { applyMasks(); return; } // 너무 작으면 취소
    addManualFace(rect);
  });

  // 마스크 스타일 선택
  styleOpts.forEach(opt => {
    opt.addEventListener('click', () => {
      const style = opt.getAttribute('data-style');
      state.maskStyle = style;

      // UI 업데이트
      styleOpts.forEach(o => o.classList.remove('active'));
      opt.classList.add('active');

      applyMasks();
      showToast('마스크 스타일이 변경되었습니다.', 'info');
    });
  });
}

// ===================================
// 파일 검증
// ===================================
function validateFiles(files) {
  const valid = [];
  const skipped = [];

  for (const f of files) {
    const name = f.name || '(이름 없음)';
    if (!f.type || !f.type.startsWith('image/')) {
      skipped.push([name, '이미지 파일이 아님']);
      continue;
    }
    if (f.size > MAX_FILE_SIZE) {
      skipped.push([name, `${(f.size / 1048576).toFixed(1)}MB · 20MB 초과`]);
      continue;
    }
    if (f.size === 0) {
      skipped.push([name, '빈 파일']);
      continue;
    }
    valid.push(f);
  }

  const room = MAX_FILE_COUNT - state.images.length;
  if (valid.length > room) {
    const cut = valid.splice(Math.max(0, room));
    cut.forEach(f => skipped.push([f.name, `최대 ${MAX_FILE_COUNT}장 초과`]));
  }

  return { valid, skipped };
}

// ===================================
// 파일 처리 (다중 파일 지원)
// ===================================
async function handleFiles(files) {
  const { valid, skipped } = validateFiles(files);

  if (skipped.length > 0) {
    const names = skipped.slice(0, 3).map(([n, r]) => `${n}(${r})`).join(', ');
    showToast(`${skipped.length}개의 파일이 제외되었습니다: ${names}${skipped.length > 3 ? ' 외' : ''}`, 'error');
  }
  if (valid.length === 0) return;

  if (!state.modelsLoaded) {
    try { await loadModels(); } catch { return; }
  }

  uploadSection.classList.add('hidden');
  processingSection.classList.remove('hidden');
  imageQueue.classList.remove('hidden');

  for (const file of valid) {
    const id = `img-${Date.now()}-${state.faceSeq++}`;
    // dataURL 대신 Blob URL 사용 (메모리 효율 + revoke 가능)
    const objectUrl = URL.createObjectURL(file);

    const imgData = {
      id,
      name: file.name,
      objectUrl,
      faces: [],
      status: 'loading',
      naturalW: 0,
      naturalH: 0
    };

    state.images.push(imgData);
    addQueueItem(imgData);
  }

  updateQueueCount();

  // 일괄 저장 버튼 노출 여부
  downloadAllBtn.classList.toggle('hidden', state.images.length <= 1);

  // 첫 번째 이미지가 아니면 순차적으로 처리 시작
  if (state.currentIndex === -1) {
    switchToImage(0);
  }

  // 아직 처리 안 된 이미지들 순차 처리
  processNextInQueue();
}

function updateQueueCount() {
  const done = state.images.filter(img => img.status === 'done').length;
  queueCount.textContent = `${done}/${state.images.length}`;
}

function addQueueItem(imgData) {
  const item = document.createElement('div');
  item.className = 'queue-item loading';
  item.id = `queue-item-${imgData.id}`;
  item.innerHTML = `<img src="${imgData.objectUrl}" alt="${escapeHtml(imgData.name)}" />`;

  item.addEventListener('click', () => {
    const idx = state.images.findIndex(img => img.id === imgData.id);
    if (idx !== -1) switchToImage(idx);
  });

  queueList.appendChild(item);
}

function updateQueueItemStatus(id, status) {
  const item = $(`queue-item-${id}`);
  if (item) {
    item.classList.remove('loading', 'done');
    item.classList.add(status);
  }
}

async function processNextInQueue() {
  const nextIdx = state.images.findIndex(img => img.status === 'loading');
  if (nextIdx === -1) return;

  const imgData = state.images[nextIdx];
  imgData.status = 'processing';

  // 감지 로직용 임시 이미지 객체
  const tempImg = new Image();
  tempImg.onload = async () => {
    // 이미지가 초기화되었거나 다른 작업으로 넘어갔는지 확인
    if (state.images.length === 0 || !state.images[nextIdx] || state.images[nextIdx].id !== imgData.id) return;

    imgData.naturalW = tempImg.naturalWidth;
    imgData.naturalH = tempImg.naturalHeight;

    const detections = await runDetectionPasses(tempImg, imgData.naturalW, imgData.naturalH);
    imgData.faces = buildFaceListForImage(detections, tempImg, imgData.naturalW, imgData.naturalH);
    imgData.status = 'done';

    updateQueueItemStatus(imgData.id, 'done');
    updateQueueCount();

    // 현재 보고 있는 이미지라면 UI 갱신
    if (state.currentIndex === nextIdx) {
      renderCurrentPage();
    }

    processNextInQueue(); // 다음 이미지
  };
  tempImg.onerror = () => {
    imgData.status = 'done';
    imgData.faces = [];
    updateQueueItemStatus(imgData.id, 'done');
    updateQueueCount();
    if (state.currentIndex === nextIdx) renderCurrentPage();
    processNextInQueue();
  };
  tempImg.src = imgData.objectUrl;
}

function switchToImage(index) {
  if (index < 0 || index >= state.images.length) return;

  state.currentIndex = index;
  const imgData = state.images[index];

  // 큐 아이템 활성화 표시
  document.querySelectorAll('.queue-item').forEach(el => el.classList.remove('active'));
  const item = $(`queue-item-${imgData.id}`);
  if (item) item.classList.add('active');

  sourceImage.onload = () => {
    renderCurrentPage();
  };
  sourceImage.onerror = () => {
    showToast('이미지를 불러오지 못했습니다.', 'error');
    setLoading(false);
  };
  sourceImage.src = imgData.objectUrl;
}

function renderCurrentPage() {
  const imgData = state.images[state.currentIndex];
  if (!imgData) return;

  // 크기 계산
  updateCanvasSizeForCurrent();

  if (imgData.status === 'done') {
    if (imgData.faces.length === 0) {
      noFaces.classList.remove('hidden');
      facesPanel.classList.add('hidden');
    } else {
      noFaces.classList.add('hidden');
      renderFacesPanel();
      facesPanel.classList.remove('hidden');
    }
    applyMasks();
    setLoading(false);
  } else {
    // 아직 처리 중
    setLoading(true, '얼굴 감지 중...');
    facesPanel.classList.add('hidden');
    noFaces.classList.add('hidden');
    const ctx = maskCanvas.getContext('2d');
    ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  }
}

function updateCanvasSizeForCurrent() {
  const imgData = state.images[state.currentIndex];
  if (!imgData) return;

  // 아직 이미지 크기를 모르면 안전하게 0으로 (NaN/Infinity 방지)
  if (!imgData.naturalW || !imgData.naturalH) {
    maskCanvas.width = 0;
    maskCanvas.height = 0;
    state.scaleX = 1;
    state.scaleY = 1;
    return;
  }

  const displayW = sourceImage.offsetWidth || 0;
  const displayH = sourceImage.offsetHeight || 0;

  // offsetWidth가 0인 경우 (초기 렌더링 시)
  if (displayW === 0) {
    const maxW = Math.min(imgData.naturalW, 800);
    const ratio = imgData.naturalH / imgData.naturalW;
    maskCanvas.width = maxW;
    maskCanvas.height = Math.round(maxW * ratio);
  } else {
    maskCanvas.width = displayW;
    maskCanvas.height = displayH;
  }

  state.scaleX = maskCanvas.width / imgData.naturalW;
  state.scaleY = maskCanvas.height / imgData.naturalH;
}

// ===================================
// 모델 로드 (SSD MobileNet v1 — 모자/안경/측면에 강함)
// 로컬 models/ 우선, 실패 시 CDN 폴백
// ===================================
async function loadModels() {
  if (state.modelsLoaded) return;
  setLoading(true, 'AI 모델 로딩 중...');

  let lastErr;
  for (const url of MODEL_URLS) {
    try {
      console.log('[페이스 모자이크] 모델 로드 시도:', url);
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri(url),
        faceapi.nets.tinyFaceDetector.loadFromUri(url),
      ]);
      state.modelsLoaded = true;
      console.log('[페이스 모자이크] 모델 로드 성공:', url);
      setLoading(false);
      return;
    } catch (err) {
      console.warn('[페이스 모자이크] 모델 로드 실패, 다음 시도...', url, err);
      lastErr = err;
    }
  }

  setLoading(false);
  showToast('모델 로딩 실패. 인터넷 연결을 확인하세요.', 'error');
  throw lastErr;
}

// ===================================
// 얼굴 감지 엔진 (핵심 로직 분리)
// ===================================
async function runDetectionPasses(img, naturalW, naturalH) {
  let bestDetections = [];
  const needsResize = naturalW > MAX_DETECT_SIZE || naturalH > MAX_DETECT_SIZE;

  let detectTarget = img;
  let scaleBackX = 1;
  let scaleBackY = 1;

  if (needsResize) {
    const scale = Math.min(MAX_DETECT_SIZE / naturalW, MAX_DETECT_SIZE / naturalH, 1);
    const w = Math.round(naturalW * scale);
    const h = Math.round(naturalH * scale);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    detectTarget = c;
    scaleBackX = naturalW / w;
    scaleBackY = naturalH / h;
  }

  const toNaturalScale = (detections) => {
    if (!needsResize) return detections;
    return detections.map(d => ({
      box: {
        x: d.box.x * scaleBackX,
        y: d.box.y * scaleBackY,
        width:  d.box.width  * scaleBackX,
        height: d.box.height * scaleBackY,
      },
      score: d.score,
    }));
  };

  const ssdOptions = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.15 });
  try {
    const res = await faceapi.detectAllFaces(detectTarget, ssdOptions);
    bestDetections = toNaturalScale(res);
  } catch (e) { console.warn('SSD fail', e); }

  if (bestDetections.length === 0) {
    const tinyOpts = new faceapi.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: 0.15 });
    try {
      const res = await faceapi.detectAllFaces(detectTarget, tinyOpts);
      bestDetections = toNaturalScale(res);
    } catch (e) { console.warn('Tiny fail', e); }
  }

  if (bestDetections.length === 0) {
    const ssdOpts3 = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.08 });
    try {
      const res = await faceapi.detectAllFaces(detectTarget, ssdOpts3);
      bestDetections = toNaturalScale(res);
    } catch (e) { console.warn('Min-conf fail', e); }
  }

  return bestDetections;
}

// 기존 detectFaces는 현재 이미지를 다시 감지할 때 사용
// 수동으로 추가한 영역은 다시 감지해도 유지된다
async function detectFaces() {
  if (state.currentIndex === -1) return;
  const imgData = state.images[state.currentIndex];

  if (!state.modelsLoaded) {
    try { await loadModels(); } catch { return; }
  }

  setLoading(true, '얼굴 다시 감지 중...');
  scanLine.classList.add('scanning');

  try {
    const manualFaces = imgData.faces.filter(f => f.manual);
    const detections = await runDetectionPasses(sourceImage, imgData.naturalW, imgData.naturalH);
    imgData.faces = [
      ...buildFaceListForImage(detections, sourceImage, imgData.naturalW, imgData.naturalH),
      ...manualFaces,
    ];
    renderCurrentPage();
  } finally {
    setLoading(false);
    scanLine.classList.remove('scanning');
  }
}

function buildFaceListForImage(detections, img, naturalW, naturalH) {
  return detections.map((det) => {
    let box;
    if (det && det.box) box = det.box;
    else if (det && det.detection && det.detection.box) box = det.detection.box;
    else return null;

    const nx = Math.max(0, box.x || 0);
    const ny = Math.max(0, box.y || 0);
    const nw = Math.min((box.width || box.w || 0), naturalW - nx);
    const nh = Math.min((box.height || box.h || 0), naturalH - ny);

    if (nw <= 10 || nh <= 10) return null;

    const cropDataUrl = cropFaceFromImage(img, nx, ny, nw, nh, naturalW, naturalH);

    return { id: `face-${state.faceSeq++}`, bbox: { x: nx, y: ny, w: nw, h: nh }, masked: true, cropDataUrl };
  }).filter(Boolean);
}

function cropFaceFromImage(img, x, y, w, h, naturalW, naturalH) {
  const pad = Math.max(w, h) * 0.15;
  const cx = Math.max(0, x - pad);
  const cy = Math.max(0, y - pad);
  const cw = Math.min(w + pad * 2, naturalW - cx);
  const ch = Math.min(h + pad * 2, naturalH - cy);

  const tmp = document.createElement('canvas');
  tmp.width = Math.max(1, Math.round(cw));
  tmp.height = Math.max(1, Math.round(ch));
  tmp.getContext('2d').drawImage(img, cx, cy, cw, ch, 0, 0, tmp.width, tmp.height);
  return tmp.toDataURL('image/jpeg', 0.8);
}

// ===================================
// 수동 영역 지정 모드
// ===================================
function toggleManualMode() {
  if (state.currentIndex === -1) return;
  state.manualMode = !state.manualMode;
  manualAddBtn.classList.toggle('active', state.manualMode);
  maskCanvas.classList.toggle('manual-mode', state.manualMode);
  showToast(
    state.manualMode ? '사진 위를 드래그해서 가릴 영역을 지정하세요.' : '수동 지정 모드를 종료합니다.',
    'info'
  );
}

function canvasPointerPos(e) {
  const r = maskCanvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function normRect(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

function addManualFace(rect) {
  const imgData = state.images[state.currentIndex];
  if (!imgData || !imgData.naturalW || !imgData.naturalH) { applyMasks(); return; }

  // display 좌표 → 원본 좌표
  const nx = Math.max(0, rect.x / state.scaleX);
  const ny = Math.max(0, rect.y / state.scaleY);
  const nw = Math.min(rect.w / state.scaleX, imgData.naturalW - nx);
  const nh = Math.min(rect.h / state.scaleY, imgData.naturalH - ny);
  if (nw < 8 || nh < 8) { applyMasks(); return; }

  const cropDataUrl = cropFaceFromImage(sourceImage, nx, ny, nw, nh, imgData.naturalW, imgData.naturalH);
  imgData.faces.push({
    id: `face-${state.faceSeq++}`,
    bbox: { x: nx, y: ny, w: nw, h: nh },
    masked: true,
    cropDataUrl,
    manual: true,
  });

  if (imgData.status === 'done') {
    noFaces.classList.add('hidden');
    renderFacesPanel();
    facesPanel.classList.remove('hidden');
  }
  applyMasks();
  showToast('수동 마스크 영역이 추가되었습니다.', 'success');
}

// ===================================
// 마스크 적용 (캔버스 렌더링)
// ===================================
function applyMasks() {
  if (state.currentIndex === -1) return;
  const imgData = state.images[state.currentIndex];

  updateCanvasSizeForCurrent();
  const ctx = maskCanvas.getContext('2d');
  ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);

  if (imgData.status === 'done') {
    // 미리보기: display 좌표계, scale = state.scaleX/Y
    drawMasksOnto(ctx, imgData, sourceImage, state.scaleX, state.scaleY, imgData.naturalW, imgData.naturalH);
  }

  // 수동 드래그 미리보기
  if (dragRect) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 90, 90, 0.95)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(dragRect.x, dragRect.y, dragRect.w, dragRect.h);
    ctx.restore();
  }
}

/**
 * 마스크 렌더링 진입점 (미리보기·단일 저장·일괄 저장 공용)
 * x, y, w, h는 bbox 원본 좌표, scale은 (출력좌표 / 원본좌표) 비율
 */
function drawMasksOnto(ctx, imgData, sourceImg, scale, naturalW, naturalH) {
  imgData.faces.forEach(face => {
    if (!face.masked) return;
    const { x, y, w, h } = face.bbox;
    const dx = x * scale;
    const dy = y * scale;
    const dw = w * scale;
    const dh = h * scale;

    switch (state.maskStyle) {
      case 'mosaic':
        drawPixelMosaic(ctx, dx, dy, dw, dh, sourceImg, scale, scale, naturalW, naturalH);
        break;
      case 'blur':
        drawBlurMask(ctx, dx, dy, dw, dh, sourceImg, scale, scale, naturalW, naturalH);
        break;
      case 'blackbar':
        drawBlackBarMask(ctx, dx, dy, dw, dh);
        break;
      default:
        drawEmojiMask(ctx, dx + dw / 2, dy + dh / 2, Math.max(dw, dh), state.maskStyle);
    }
  });
}

// ---- 픽셀 모자이크 (미리보기·저장 공용 단일 구현) ----
function drawPixelMosaic(ctx, x, y, w, h, sourceImg, scaleX, scaleY, naturalW, naturalH) {
  const blockSize = Math.max(8, Math.min(w, h) * 0.1);
  const padding = Math.max(w, h) * 0.08;

  // 출력 좌표계에서 패딩 rect를 구한 뒤 원본 경계로 클램프
  const px = Math.max(0, x - padding);
  const py = Math.max(0, y - padding);
  const maxW = naturalW * scaleX;
  const maxH = naturalH * scaleY;
  const pw = Math.min(w + padding * 2, maxW - px);
  const ph = Math.min(h + padding * 2, maxH - py);
  if (!(pw > 0 && ph > 0)) return;

  // 원본에서 픽셀 샘플링 후 블록화
  const offscreen = document.createElement('canvas');
  offscreen.width  = Math.max(1, Math.ceil(pw / blockSize));
  offscreen.height = Math.max(1, Math.ceil(ph / blockSize));
  const octx = offscreen.getContext('2d');
  octx.drawImage(sourceImg, px / scaleX, py / scaleY, pw / scaleX, ph / scaleY, 0, 0, offscreen.width, offscreen.height);

  const cx = px + pw / 2;
  const cy = py + ph / 2;

  // 원형 클리핑 후 확대 (모자이크 효과)
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.beginPath();
  ctx.ellipse(cx, cy, pw / 2 * 1.05, ph / 2 * 1.05, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(offscreen, px, py, pw, ph);

  // 보라색 오버레이 (복원 난이도 상승 + 디자인 통일)
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = 'rgba(100, 40, 180, 0.7)';
  ctx.fillRect(px, py, pw, ph);
  ctx.globalAlpha = 1;
  ctx.restore();

  drawMaskRing(ctx, cx, cy, pw, ph);
}

// ---- 블러 마스크 ----
function drawBlurMask(ctx, x, y, w, h, sourceImg, scaleX, scaleY, naturalW, naturalH) {
  const padding = Math.max(w, h) * 0.08;
  const px = Math.max(0, x - padding);
  const py = Math.max(0, y - padding);
  const maxW = naturalW * scaleX;
  const maxH = naturalH * scaleY;
  const pw = Math.min(w + padding * 2, maxW - px);
  const ph = Math.min(h + padding * 2, maxH - py);
  if (!(pw > 0 && ph > 0)) return;

  // 작게 그린 뒤 확대 = 블러 효과 (2패스)
  const off = document.createElement('canvas');
  off.width = Math.max(1, Math.round(pw / 14));
  off.height = Math.max(1, Math.round(ph / 14));
  const octx = off.getContext('2d');
  octx.drawImage(sourceImg, px / scaleX, py / scaleY, pw / scaleX, ph / scaleY, 0, 0, off.width, off.height);

  const cx = px + pw / 2;
  const cy = py + ph / 2;

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, pw / 2 * 1.05, ph / 2 * 1.05, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, px, py, pw, ph);
  ctx.globalAlpha = 0.45;
  ctx.drawImage(off, px, py, pw, ph);
  ctx.globalAlpha = 1;
  ctx.restore();

  drawMaskRing(ctx, cx, cy, pw, ph);
}

// ---- 블랙바 마스크 (눈 주변 가림) ----
function drawBlackBarMask(ctx, x, y, w, h) {
  const padding = Math.max(w, h) * 0.06;
  const bx = x - padding;
  const by = y + h * 0.15;
  const bw = w + padding * 2;
  const bh = h * 0.5;

  ctx.save();
  ctx.fillStyle = 'rgba(8, 8, 10, 0.94)';
  const r = Math.min(bw, bh) * 0.25;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(bx, by, bw, bh, r);
  } else {
    ctx.rect(bx, by, bw, bh);
  }
  ctx.fill();
  ctx.restore();
}

// ---- 마스크 테두리 링 (공용) ----
function drawMaskRing(ctx, cx, cy, pw, ph) {
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, pw / 2 * 1.05, ph / 2 * 1.05, 0, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(168, 85, 247, 0.7)';
  ctx.lineWidth = Math.max(2, Math.min(pw, ph) * 0.015);
  ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.restore();
}

// ---- 이모지 마스크 (미리보기·저장 공용 단일 구현) ----
function drawEmojiMask(ctx, cx, cy, size, emoji) {
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
  ctx.shadowBlur = Math.max(4, size * 0.08);
  ctx.shadowOffsetX = size * 0.02;
  ctx.shadowOffsetY = size * 0.02;

  const fontSize = size * 1.1;
  ctx.font = `${fontSize}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillText(emoji, cx, cy);
  ctx.restore();
}

// ===================================
// 얼굴 패널 렌더링
// ===================================
function renderFacesPanel() {
  if (state.currentIndex === -1) return;
  const imgData = state.images[state.currentIndex];

  facesCount.textContent = `${imgData.faces.length}개`;
  facesGrid.innerHTML = '';

  imgData.faces.forEach((face, i) => {
    const card = createFaceCard(face, i);
    card.style.animationDelay = `${i * 60}ms`;
    facesGrid.appendChild(card);
  });
}

function createFaceCard(face, index) {
  const card = document.createElement('div');
  card.className = `face-card ${face.masked ? 'masked' : 'unmasked'}`;
  card.id = `face-card-${face.id}`;

  card.innerHTML = `
    <div class="face-thumb-wrap">
      <img src="${face.cropDataUrl}" alt="얼굴 ${index + 1}" />
      <div class="face-status-badge ${face.masked ? 'masked' : 'unmasked'}" id="badge-${face.id}">
        ${face.masked ? '🔒' : '👁'}
      </div>
    </div>
    <div class="face-card-body">
      <span class="face-label">얼굴 ${index + 1}${face.manual ? ' · 수동' : ''}</span>
      <div class="toggle-wrap">
        <input
          type="checkbox"
          class="toggle-input"
          id="toggle-${face.id}"
          ${face.masked ? 'checked' : ''}
        />
        <label class="toggle-label" for="toggle-${face.id}"></label>
      </div>
    </div>
  `;

  const toggle = card.querySelector('.toggle-input');
  const thumbWrap = card.querySelector('.face-thumb-wrap');
  thumbWrap.style.cursor = 'pointer';
  thumbWrap.addEventListener('click', () => {
    face.masked = !face.masked;
    if (toggle) toggle.checked = face.masked;
    updateFaceCard(face);
    applyMasks();
  });

  return card;
}

function updateFaceCard(face) {
  const card = $(`face-card-${face.id}`);
  const badge = $(`badge-${face.id}`);
  if (!card || !badge) return;

  card.className = `face-card ${face.masked ? 'masked' : 'unmasked'}`;
  badge.className = `face-status-badge ${face.masked ? 'masked' : 'unmasked'}`;
  badge.textContent = face.masked ? '🔒' : '👁';
}

// ===================================
// 전체 마스킹 / 해제
// ===================================
function setAllMasks(masked) {
  if (state.currentIndex === -1) return;
  const imgData = state.images[state.currentIndex];

  imgData.faces.forEach(face => {
    face.masked = masked;
    const toggle = $(`toggle-${face.id}`);
    if (toggle) toggle.checked = masked;
    updateFaceCard(face);
  });
  applyMasks();
  showToast(masked ? '전체 마스킹 적용됨' : '전체 마스킹 해제됨', 'info');
}

// ===================================
// 이미지 저장
// ===================================

// iOS Safari 캔버스 면적 제한 등을 고려한 출력 크기 계산
function getOutputSize(naturalW, naturalH) {
  const megapixels = (naturalW * naturalH) / 1e6;
  if (megapixels <= MAX_OUTPUT_MEGAPIXELS) {
    return { w: naturalW, h: naturalH, scaled: false };
  }
  const s = Math.sqrt((MAX_OUTPUT_MEGAPIXELS * 1e6) / (naturalW * naturalH));
  return { w: Math.round(naturalW * s), h: Math.round(naturalH * s), scaled: true };
}

function baseName(name) {
  const i = (name || '').lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : (name || 'image');
}

function triggerDownload(url, filename, revokeAfterMs = 10000) {
  const link = document.createElement('a');
  link.download = filename;
  link.href = url;
  document.body.appendChild(link);
  link.click();
  link.remove();
  if (revokeAfterMs > 0) {
    setTimeout(() => URL.revokeObjectURL(url), revokeAfterMs);
  }
}

async function downloadMaskedImage() {
  if (state.currentIndex === -1) return;
  const imgData = state.images[state.currentIndex];

  const out = getOutputSize(imgData.naturalW, imgData.naturalH);
  if (out.scaled) {
    showToast(`이미지가 커서 ${out.w}×${out.h}px로 축소 저장됩니다.`, 'info');
  }
  const s = out.w / imgData.naturalW;

  const output = document.createElement('canvas');
  output.width = out.w;
  output.height = out.h;
  const ctx = output.getContext('2d');

  ctx.drawImage(sourceImage, 0, 0, out.w, out.h);

  // 미리보기와 동일한 drawMasksOnto 사용 (좌표계만 출력 크기에 맞춤)
  drawMasksOnto(ctx, imgData, sourceImage, s, imgData.naturalW, imgData.naturalH);

  output.toBlob(blob => {
    if (!blob) {
      showToast('이미지 저장에 실패했습니다.', 'error');
      return;
    }
    triggerDownload(URL.createObjectURL(blob), `${baseName(imgData.name)}_mosaic.jpg`);
    showToast('이미지가 저장되었습니다!', 'success');
  }, 'image/jpeg', 0.92);
}

async function downloadAllImages() {
  if (state.images.length === 0) return;
  if (typeof JSZip === 'undefined') {
    showToast('압축 라이브러리를 로드 중입니다. 잠시 후 다시 시도하세요.', 'info');
    return;
  }

  const doneImages = state.images.filter(img => img.status === 'done');
  if (doneImages.length === 0) {
    showToast('처리 완료된 사진이 없습니다.', 'error');
    return;
  }

  setLoading(true, '사진 일괄 압축 중...');
  const zip = new JSZip();
  const folder = zip.folder('face_mosaic_photos');

  try {
    for (const imgData of doneImages) {
      const blob = await renderMaskedBlob(imgData);
      folder.file(`${baseName(imgData.name)}_mosaic.jpg`, blob);
    }

    const content = await zip.generateAsync({ type: 'blob' });
    triggerDownload(URL.createObjectURL(content), `face_mosaic_batch_${Date.now()}.zip`);
    showToast(`${doneImages.length}장의 사진이 ZIP으로 저장되었습니다!`, 'success');
  } catch (err) {
    console.error('Batch download error:', err);
    showToast('일괄 저장 중 오류가 발생했습니다.', 'error');
  } finally {
    setLoading(false);
  }
}

async function renderMaskedBlob(imgData) {
  return new Promise((resolve, reject) => {
    const tempImg = new Image();
    tempImg.onload = () => {
      const out = getOutputSize(imgData.naturalW, imgData.naturalH);
      const s = out.w / imgData.naturalW;
      const canvas = document.createElement('canvas');
      canvas.width = out.w;
      canvas.height = out.h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(tempImg, 0, 0, out.w, out.h);

      // 단일 저장과 동일한 마스크 렌더링 경로
      drawMasksOnto(ctx, imgData, tempImg, s, imgData.naturalW, imgData.naturalH);

      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('toBlob failed')), 'image/jpeg', 0.9);
    };
    tempImg.onerror = () => reject(new Error('image load failed'));
    tempImg.src = imgData.objectUrl;
  });
}

// ===================================
// 초기화 (업로드 화면으로)
// ===================================
function resetToUpload() {
  // Blob URL 해제 (메모리 누수 방지)
  state.images.forEach(img => {
    if (img.objectUrl) {
      try { URL.revokeObjectURL(img.objectUrl); } catch { /* noop */ }
    }
  });

  state.images = [];
  state.currentIndex = -1;
  state.manualMode = false;
  manualAddBtn.classList.remove('active');
  maskCanvas.classList.remove('manual-mode');
  dragStart = null;
  dragRect = null;

  fileInput.value = '';
  queueList.innerHTML = '';
  facesGrid.innerHTML = '';

  imageQueue.classList.add('hidden');
  facesPanel.classList.add('hidden');
  noFaces.classList.add('hidden');
  processingSection.classList.add('hidden');
  uploadSection.classList.remove('hidden');

  const ctx = maskCanvas.getContext('2d');
  ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
}

// ===================================
// 로딩 UI
// ===================================
function setLoading(visible, text = '') {
  if (visible) {
    loadingText.textContent = text;
    loadingOverlay.classList.remove('hidden');
  } else {
    loadingOverlay.classList.add('hidden');
  }
}

// ===================================
// 토스트 알림
// ===================================
function showToast(message, type = 'info') {
  const icons = {
    success: '✓',
    error:   '✕',
    info:    '◈',
  };

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-icon">${icons[type] || '◈'}</div>
    <span>${escapeHtml(message)}</span>
  `;

  $('toastContainer').appendChild(toast);

  setTimeout(() => {
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 280);
  }, 3000);
}

// 파일명 등 사용자 입력이 HTML에 들어갈 때 이스케이프
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ===================================
// 창 크기 변경 시 캔버스 재조정
// ===================================
window.addEventListener('resize', () => {
  if (state.currentIndex !== -1) {
    requestAnimationFrame(applyMasks);
  }
});
