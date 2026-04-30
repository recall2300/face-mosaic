/**
 * 페이스 모자이크 - 얼굴 자동 마스킹 웹앱
 * face-api.js 기반 클라이언트 사이드 처리
 */

// ===================================
// 상태 관리
// ===================================
const state = {
  modelsLoaded: false,
  images: [],               // { id, file, dataUrl, naturalW, naturalH, faces: [], status: 'loading'|'done' }
  currentIndex: -1,         // 현재 보고 있는 이미지 인덱스
  maskStyle: 'mosaic',      // 'mosaic' 또는 이모지 문자열
  // 현재 활성화된 이미지의 렌더링용 임시 값들
  scaleX: 1,
  scaleY: 1,
};

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
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
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
    const files = Array.from(e.target.files).filter(f => f.type.startsWith('image/'));
    if (files.length > 0) handleFiles(files);
  });

  // 버튼들
  newImageBtn.addEventListener('click', resetToUpload);
  rescanBtn.addEventListener('click', () => detectFaces());
  downloadBtn.addEventListener('click', downloadMaskedImage);
  downloadAllBtn.addEventListener('click', downloadAllImages);
  maskAllBtn.addEventListener('click', () => setAllMasks(true));
  unmaskAllBtn.addEventListener('click', () => setAllMasks(false));

  // 마스크 스타일 선택
  styleOpts.forEach(opt => {
    opt.addEventListener('click', () => {
      const style = opt.getAttribute('data-style');
      state.maskStyle = style;
      
      // UI 업데이트
      styleOpts.forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
      
      applyMasks();
      showToast(`마스크 스타일이 변경되었습니다.`, 'info');
    });
  });
}

// ===================================
// 파일 처리 (다중 파일 지원)
// ===================================
async function handleFiles(files) {
  if (!state.modelsLoaded) {
    try { await loadModels(); } catch { return; }
  }

  uploadSection.classList.add('hidden');
  processingSection.classList.remove('hidden');
  imageQueue.classList.remove('hidden');

  const startIndex = state.images.length;
  
  for (const file of files) {
    const id = Date.now() + Math.random().toString(36).substr(2, 5);
    const dataUrl = await readFileAsDataURL(file);
    
    const imgData = {
      id,
      name: file.name,
      dataUrl,
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
  if (state.images.length > 1) {
    downloadAllBtn.classList.remove('hidden');
  } else {
    downloadAllBtn.classList.add('hidden');
  }

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
  item.innerHTML = `<img src="${imgData.dataUrl}" alt="${imgData.name}" />`;
  
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
  tempImg.src = imgData.dataUrl;
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
  sourceImage.src = imgData.dataUrl;
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

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ===================================
// 모델 로드 (SSD MobileNet v1 — 모자/안경/측면에 강함)
// ===================================
const CDN_URLS = [
  'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/weights',
  'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights',
];

async function loadModels() {
  if (state.modelsLoaded) return;
  setLoading(true, 'AI 모델 로딩 중...');

  let lastErr;
  for (const url of CDN_URLS) {
    try {
      console.log('[페이스 모자이크] 모델 로드 시도:', url);
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri(url),
        faceapi.nets.tinyFaceDetector.loadFromUri(url),
      ]);
      state.modelsLoaded = true;
      state.modelUrl = url;
      console.log('[페이스 모자이크] 모델 로드 성공:', url);
      return;
    } catch (err) {
      console.warn('[페이스 모자이크] CDN 실패, 다음 시도...', url, err);
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
  const MAX_DETECT_SIZE = 1024;
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
      _isScaled: true,
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
async function detectFaces() {
  if (state.currentIndex === -1) return;
  const imgData = state.images[state.currentIndex];
  
  if (!state.modelsLoaded) {
    try { await loadModels(); } catch { return; }
  }

  setLoading(true, '얼굴 다시 감지 중...');
  scanLine.classList.add('scanning');

  try {
    const detections = await runDetectionPasses(sourceImage, imgData.naturalW, imgData.naturalH);
    imgData.faces = buildFaceListForImage(detections, sourceImage, imgData.naturalW, imgData.naturalH);
    renderCurrentPage();
  } finally {
    setLoading(false);
    scanLine.classList.remove('scanning');
  }
}

// 고해상도 이미지 리사이즈 헬퍼
function resizeForDetection(img, maxSize) {
  return new Promise(resolve => {
    const scale = Math.min(maxSize / img.naturalWidth, maxSize / img.naturalHeight, 1);
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const c = document.createElement('canvas');
    c.width  = w;
    c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    const out = new Image();
    out.onload = () => resolve(out);
    out.src = c.toDataURL();
  });
}

function buildFaceListForImage(detections, img, naturalW, naturalH) {
  return detections.map((det, i) => {
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

    return { id: i, bbox: { x: nx, y: ny, w: nw, h: nh }, masked: true, cropDataUrl };
  }).filter(Boolean);
}

function cropFaceFromImage(img, x, y, w, h, naturalW, naturalH) {
  const pad = Math.max(w, h) * 0.15;
  const cx = Math.max(0, x - pad);
  const cy = Math.max(0, y - pad);
  const cw = Math.min(w + pad * 2, naturalW - cx);
  const ch = Math.min(h + pad * 2, naturalH - cy);

  const tmp = document.createElement('canvas');
  tmp.width = Math.round(cw);
  tmp.height = Math.round(ch);
  tmp.getContext('2d').drawImage(img, cx, cy, cw, ch, 0, 0, tmp.width, tmp.height);
  return tmp.toDataURL('image/jpeg', 0.8);
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

  imgData.faces.forEach(face => {
    if (!face.masked) return;

    const x = face.bbox.x * state.scaleX;
    const y = face.bbox.y * state.scaleY;
    const w = face.bbox.w * state.scaleX;
    const h = face.bbox.h * state.scaleY;
    const cx = x + w / 2;
    const cy = y + h / 2;

    if (state.maskStyle === 'mosaic') {
      drawPixelMask(ctx, x, y, w, h);
    } else {
      drawEmojiMask(ctx, cx, cy, Math.max(w, h), state.maskStyle);
    }
  });
}

function drawEmojiMask(ctx, cx, cy, size, emoji) {
  ctx.save();
  // 그림자 효과 (입체감)
  ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 2;

  // 폰트 크기 조절 (얼굴 크기에 맞게)
  const fontSize = size * 1.1;
  ctx.font = `${fontSize}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  
  ctx.fillText(emoji, cx, cy);
  ctx.restore();
}

function drawPixelMask(ctx, x, y, w, h) {
  const blockSize = Math.max(8, Math.min(w, h) * 0.1);
  const padding = Math.max(w, h) * 0.08;
  const px = x - padding;
  const py = y - padding;
  const pw = w + padding * 2;
  const ph = h + padding * 2;

  // 원본 이미지에서 픽셀 샘플링 후 블록화
  const offscreen = document.createElement('canvas');
  offscreen.width  = Math.ceil(pw / blockSize);
  offscreen.height = Math.ceil(ph / blockSize);
  const octx = offscreen.getContext('2d');

  // 자연 크기 기준으로 소스에서 복사
  const srcX = px / state.scaleX;
  const srcY = py / state.scaleY;
  const srcW = pw / state.scaleX;
  const srcH = ph / state.scaleY;
  octx.drawImage(sourceImage, srcX, srcY, srcW, srcH, 0, 0, offscreen.width, offscreen.height);

  // 다시 확대해서 모자이크 효과
  ctx.save();
  ctx.imageSmoothingEnabled = false;

  // 원형 클리핑
  const cx = px + pw / 2;
  const cy = py + ph / 2;
  const rx = pw / 2;
  const ry = ph / 2;

  ctx.beginPath();
  ctx.ellipse(cx, cy, rx * 1.05, ry * 1.05, 0, 0, Math.PI * 2);
  ctx.clip();

  ctx.drawImage(offscreen, px, py, pw, ph);

  // 보라색 오버레이 + 테두리
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = 'rgba(100, 40, 180, 0.7)';
  ctx.fillRect(px, py, pw, ph);
  ctx.globalAlpha = 1;

  ctx.restore();

  // 테두리 링
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx * 1.05, ry * 1.05, 0, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(168, 85, 247, 0.7)';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.stroke();
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
      <span class="face-label">얼굴 ${index + 1}</span>
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

  const thumbWrap = card.querySelector('.face-thumb-wrap');
  thumbWrap.style.cursor = 'pointer';
  thumbWrap.addEventListener('click', () => {
    face.masked = !face.masked;
    toggle.checked = face.masked;
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
async function downloadMaskedImage() {
  if (state.currentIndex === -1) return;
  const imgData = state.images[state.currentIndex];

  const output = document.createElement('canvas');
  output.width  = imgData.naturalW;
  output.height = imgData.naturalH;
  const ctx = output.getContext('2d');

  ctx.drawImage(sourceImage, 0, 0);

  const origScaleX = state.scaleX;
  const origScaleY = state.scaleY;
  state.scaleX = 1;
  state.scaleY = 1;

  imgData.faces.forEach(face => {
    if (!face.masked) return;
    const { x, y, w, h } = face.bbox;
    
    if (state.maskStyle === 'mosaic') {
      drawPixelMaskOnCanvas(ctx, x, y, w, h);
    } else {
      const cx = x + w / 2;
      const cy = y + h / 2;
      drawEmojiMaskOnCanvas(ctx, cx, cy, Math.max(w, h), state.maskStyle);
    }
  });

  state.scaleX = origScaleX;
  state.scaleY = origScaleY;

  const link = document.createElement('a');
  link.download = `face_mosaic_${Date.now()}.jpg`;
  link.href = output.toDataURL('image/jpeg', 0.92);
  link.click();

  showToast('이미지가 저장되었습니다!', 'success');
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
      folder.file(`${imgData.name.split('.')[0]}_mosaic.jpg`, blob);
    }

    const content = await zip.generateAsync({ type: 'blob' });
    const link = document.createElement('a');
    link.download = `face_mosaic_batch_${Date.now()}.zip`;
    link.href = URL.createObjectURL(content);
    link.click();
    
    showToast(`${doneImages.length}장의 사진이 ZIP으로 저장되었습니다!`, 'success');
  } catch (err) {
    console.error('Batch download error:', err);
    showToast('일괄 저장 중 오류가 발생했습니다.', 'error');
  } finally {
    setLoading(false);
  }
}

async function renderMaskedBlob(imgData) {
  return new Promise((resolve) => {
    const tempImg = new Image();
    tempImg.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = imgData.naturalW;
      canvas.height = imgData.naturalH;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(tempImg, 0, 0);

      // 마스크 적용
      imgData.faces.forEach(face => {
        if (!face.masked) return;
        const { x, y, w, h } = face.bbox;
        if (state.maskStyle === 'mosaic') {
          drawPixelMaskOnCanvasForImg(ctx, x, y, w, h, tempImg, imgData.naturalW, imgData.naturalH);
        } else {
          drawEmojiMaskOnCanvas(ctx, x + w / 2, y + h / 2, Math.max(w, h), state.maskStyle);
        }
      });

      canvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.9);
    };
    tempImg.src = imgData.dataUrl;
  });
}

// downloadMaskedImage에서 쓰던 logic을 일반화하여 인자를 명시적으로 받도록 수정/추가 필요
function drawPixelMaskOnCanvasForImg(ctx, x, y, w, h, sourceImg, naturalW, naturalH) {
  const blockSize = Math.max(12, Math.min(w, h) * 0.1);
  const padding = Math.max(w, h) * 0.08;
  const px = Math.max(0, x - padding);
  const py = Math.max(0, y - padding);
  const pw = Math.min(w + padding * 2, naturalW - px);
  const ph = Math.min(h + padding * 2, naturalH - py);

  const offscreen = document.createElement('canvas');
  offscreen.width  = Math.ceil(pw / blockSize);
  offscreen.height = Math.ceil(ph / blockSize);
  const octx = offscreen.getContext('2d');
  octx.drawImage(sourceImg, px, py, pw, ph, 0, 0, offscreen.width, offscreen.height);

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  const cx = px + pw / 2;
  const cy = py + ph / 2;
  ctx.beginPath();
  ctx.ellipse(cx, cy, pw / 2 * 1.05, ph / 2 * 1.05, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(offscreen, px, py, pw, ph);
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = 'rgba(100, 40, 180, 0.7)';
  ctx.fillRect(px, py, pw, ph);
  ctx.globalAlpha = 1;
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, pw / 2 * 1.05, ph / 2 * 1.05, 0, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(168, 85, 247, 0.7)';
  ctx.lineWidth = 3;
  ctx.setLineDash([8, 5]);
  ctx.stroke();
  ctx.restore();
}

function drawPixelMaskOnCanvas(ctx, x, y, w, h) {
  const blockSize = Math.max(12, Math.min(w, h) * 0.1);
  const padding = Math.max(w, h) * 0.08;
  const px = Math.max(0, x - padding);
  const py = Math.max(0, y - padding);
  const pw = Math.min(w + padding * 2, state.naturalW - px);
  const ph = Math.min(h + padding * 2, state.naturalH - py);

  const offscreen = document.createElement('canvas');
  offscreen.width  = Math.ceil(pw / blockSize);
  offscreen.height = Math.ceil(ph / blockSize);
  const octx = offscreen.getContext('2d');
  octx.drawImage(sourceImage, px, py, pw, ph, 0, 0, offscreen.width, offscreen.height);

  ctx.save();
  ctx.imageSmoothingEnabled = false;

  const cx = px + pw / 2;
  const cy = py + ph / 2;
  ctx.beginPath();
  ctx.ellipse(cx, cy, pw / 2 * 1.05, ph / 2 * 1.05, 0, 0, Math.PI * 2);
  ctx.clip();

  ctx.drawImage(offscreen, px, py, pw, ph);

  ctx.globalAlpha = 0.35;
  ctx.fillStyle = 'rgba(100, 40, 180, 0.7)';
  ctx.fillRect(px, py, pw, ph);
  ctx.globalAlpha = 1;
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, pw / 2 * 1.05, ph / 2 * 1.05, 0, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(168, 85, 247, 0.7)';
  ctx.lineWidth = 3;
  ctx.setLineDash([8, 5]);
  ctx.stroke();
  ctx.restore();
}

function drawEmojiMaskOnCanvas(ctx, cx, cy, size, emoji) {
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
  ctx.shadowBlur = size * 0.1;
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
// 초기화 (업로드 화면으로)
// ===================================
function resetToUpload() {
  state.images = [];
  state.currentIndex = -1;
  
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
    <span>${message}</span>
  `;

  $('toastContainer').appendChild(toast);

  setTimeout(() => {
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 280);
  }, 3000);
}

// ===================================
// 창 크기 변경 시 캔버스 재조정
// ===================================
window.addEventListener('resize', () => {
  if (state.currentIndex !== -1) {
    requestAnimationFrame(applyMasks);
  }
});
