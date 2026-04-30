# 정적 파일 서비스를 위해 가벼운 nginx:alpine 이미지를 사용합니다.
FROM nginx:alpine

# 프로젝트의 모든 파일을 nginx의 기본 웹 디렉토리로 복사합니다.
COPY . /usr/share/nginx/html

# 80 포트를 노출합니다.
EXPOSE 80

# nginx를 실행합니다.
CMD ["nginx", "-g", "daemon off;"]
