# 정적 파일 서비스를 위해 가벼운 nginx:alpine 이미지를 사용합니다.
FROM nginx:alpine

# 커스텀 nginx 설정 (gzip + 정적 에셋 장기 캐시)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# 프로젝트의 정적 파일을 nginx의 기본 웹 디렉토리로 복사합니다.
# (.dockerignore에 의해 .git, docs 등은 제외됩니다)
COPY . /usr/share/nginx/html

# 80 포트를 노출합니다.
EXPOSE 80

# nginx를 실행합니다.
CMD ["nginx", "-g", "daemon off;"]
