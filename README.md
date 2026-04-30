# 🎭 페이스 모자이크 (Face Mosaic)

AI 기반 자동 얼굴 마스킹 웹 서비스입니다. 사진 속 얼굴을 자동으로 감지하여 모자이크 처리하거나 귀여운 이모지로 가려줍니다.

## ✨ 주요 기능
- **자동 얼굴 감지**: AI(face-api.js)를 사용하여 사진 내 모든 얼굴을 정밀하게 찾아냅니다.
- **다양한 마스킹 스타일**: 고전적인 모자이크부터 14종의 다양한 애플 스타일 이모지를 지원합니다.
- **다중 사진 일괄 처리**: 여러 장의 사진을 한 번에 업로드하고 백그라운드에서 순차적으로 처리합니다.
- **일괄 저장**: 처리된 모든 결과물을 하나의 ZIP 파일로 간편하게 저장할 수 있습니다.
- **개인정보 보호**: 모든 처리는 사용자의 브라우저 내에서만 이루어집니다. 사진이 서버로 전송되지 않아 안전합니다.

## 🚀 실행 방법 (How to Run)
이 프로젝트는 별도의 서버 설치가 필요 없는 **순수 정적 웹앱**이지만, AI 모델 파일 로딩을 위해 **로컬 서버 환경**에서 실행하는 것이 좋습니다. (파일 직접 열기 방식은 브라우저 보안 정책상 모델 로드가 차단될 수 있습니다.)

### 방법 1: GitHub Pages (가장 쉽고 빠른 공유)
깃허브에 코드를 올린 후 몇 번의 클릭만으로 전 세계에 무료 배포할 수 있습니다.
1. GitHub 저장소의 **Settings** > **Pages** 메뉴로 이동합니다.
2. **Build and deployment** 섹션에서 Branch를 `main`으로 설정하고 **Save**를 누릅니다.
3. 약 1분 후 `https://[사용자아이디].github.io/[저장소이름]` 주소로 자동 배포됩니다.

### 방법 2: Docker 사용 (Synology NAS 등)
도커를 지원하는 NAS나 서버에서 가장 깔끔하게 구동하는 방법입니다.

**1. 이미지 빌드 및 실행 (로컬)**
```bash
# 이미지 빌드
docker build -t face-mosaic .

# 컨테이너 실행 (8080 포트로 접속)
docker run -d -p 8080:80 --name face-mosaic face-mosaic
```

**2. Synology NAS에서 실행하기**
1. NAS의 **Docker (또는 Container Manager)** 앱을 엽니다.
2. **레지스트리**에서 `nginx`를 검색하여 다운로드하거나, 본인이 빌드하여 Docker Hub에 올린 이미지를 검색합니다.
3. **이미지** 탭에서 실행을 누르고 **포트 설정**에서 `로컬 포트: 8080` -> `컨테이너 포트: 80`으로 연결합니다.
4. 이제 `http://[NAS아이피]:8080`으로 접속하면 바로 사용할 수 있습니다.

### 방법 3: VS Code / Node.js (개발용)
... (기존 내용 유지)

## 💻 부하 분석 및 기술적 특징
- **서버 부하**: **거의 없음.** 서버는 오직 정적 파일(HTML, CSS, JS, AI 모델 파일)만 제공합니다.
- **사용자 기기 부하**: 모든 AI 연산(TensorFlow.js)이 사용자의 기기(CPU/GPU)에서 수행됩니다. 최신 브라우저와 하드웨어에서 최적의 성능을 발휘합니다.
- **크로스 플랫폼**: 웹 표준 기술로 제작되어 Windows, macOS, Linux 등 브라우저가 있는 모든 OS에서 동일하게 작동합니다.

## 🛠 기술 스택
- **Core**: JavaScript (Vanilla JS)
- **AI Engine**: [face-api.js](https://github.com/justadudewhohacks/face-api.js) (TensorFlow.js 기반)
- **Styling**: Vanilla CSS (Modern CSS variables, Glassmorphism)
- **Compression**: [JSZip](https://stuk.github.io/jszip/)

## 📄 라이선스
MIT License
