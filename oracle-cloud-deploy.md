# 오라클 클라우드 PM2 배포 가이드

## 1. 오라클 클라우드 인스턴스 준비

### 필수 소프트웨어 설치

```bash
# Node.js 22 설치
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# PM2 전역 설치
sudo npm install -g pm2

# Git 설치 (없는 경우)
sudo apt-get install git
```

## 2. 방화벽 및 보안 그룹 설정

### 오라클 클라우드 콘솔에서:

1. **Compute > Instances** 에서 인스턴스 선택
2. **Virtual Cloud Network** 클릭
3. **Security Lists** 에서 Default Security List 선택
4. **Add Ingress Rules** 클릭하여 다음 규칙 추가:
   - **Source CIDR**: 0.0.0.0/0
   - **IP Protocol**: TCP
   - **Destination Port Range**: 3050

### 서버 내부 방화벽 설정:

```bash
# iptables 규칙 추가
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3050 -j ACCEPT
sudo netfilter-persistent save

# 또는 ufw 사용 (Ubuntu)
sudo ufw allow 3050
```

## 3. 서버 배포

### 코드 배포

```bash
# 홈 디렉토리로 이동
cd ~

# 저장소 클론
git clone https://github.com/Cardanoian/discussion-server.git
cd discussion-server

# 의존성 설치
npm install

# TypeScript 빌드
npm run build
```

### 환경변수 설정

```bash
# .env 파일 생성
cp .env.example .env
nano .env
```

**.env 파일 내용:**

```env
NODE_ENV=production
PORT=3050
SUPABASE_URL=""
SUPABASE_ANON_KEY=""
GEMINI_API_KEY=""
FRONTEND_URL=http://129.154.48.207/
```

## 4. PM2로 서버 시작

```bash
# 로그 디렉토리 생성
mkdir -p logs

# PM2로 애플리케이션 시작
pm2 start ecosystem.config.js --env production

# PM2 상태 확인
pm2 status

# 로그 확인
pm2 logs discussion-server

# 실시간 모니터링
pm2 monit
```

## 5. 시스템 재시작 시 자동 시작 설정

```bash
# PM2 startup 스크립트 생성
pm2 startup

# 위 명령어 실행 후 나오는 sudo 명령어를 복사해서 실행
# 예: sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u ubuntu --hp /home/ubuntu

# 현재 PM2 프로세스 저장
pm2 save
```

## 6. 서버 상태 확인

### 서버 접속 테스트

```bash
# 로컬에서 테스트
curl http://localhost:3050/

# 외부에서 테스트 (오라클 클라우드 인스턴스 공인 IP 사용)
curl http://129.154.48.207:3050/
```

### 헬스 체크

```bash
curl http://129.154.48.207:3050/health
```

## 7. 유용한 PM2 명령어

```bash
# 애플리케이션 재시작
pm2 restart discussion-server

# 애플리케이션 중지
pm2 stop discussion-server

# 애플리케이션 삭제
pm2 delete discussion-server

# 로그 확인
pm2 logs discussion-server --lines 100

# 메모리 사용량 확인
pm2 show discussion-server
```

## 8. 업데이트 배포

```bash
# 코드 업데이트
cd ~/discussion-server
git pull origin main

# 의존성 업데이트 (필요한 경우)
npm install

# 빌드
npm run build

# PM2 재시작
pm2 restart discussion-server
```

## 9. 트러블슈팅

### 포트 확인

```bash
# 포트 3050이 열려있는지 확인
sudo netstat -tlnp | grep :3050
```

### 프로세스 확인

```bash
# Node.js 프로세스 확인
ps aux | grep node
```

### 로그 확인

```bash
# PM2 로그
pm2 logs discussion-server

# 시스템 로그
sudo journalctl -u pm2-ubuntu
```

## 완료!

서버가 성공적으로 배포되면 다음 URL에서 접근 가능합니다:

- **서버 상태**: `http://129.154.48.207:3050/`
- **헬스 체크**: `http://129.154.48.207:3050/health`
- **Socket.IO**: 프론트엔드에서 `http://129.154.48.207:3050` 로 연결

CORS 설정이 완료되어 `http://129.154.48.207/` 에서 안전하게 접근할 수 있습니다.
