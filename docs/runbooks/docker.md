# Docker로 로컬에서 시험하기

내 컴퓨터(macOS·Windows·Linux)의 Docker에서 데몬 하나를 띄워 AI·터미널·웹 화면을 시험하는 방법입니다. systemd 설치 대신 컨테이너 안에서 데몬을 직접 실행합니다. 운영 서버 설치는 [README의 설치와 사용법](../../README.md#설치와-사용법)을 따르세요.

> **먼저 알아둘 점**
> - 비공식 클라이언트라 카카오 계정 제재 위험이 있습니다. 시험용 계정이나 위험을 받아들인 계정으로 하세요.
> - 다른 PC가 같은 계정을 쓰고 있으면 로그인이 중단될 수 있습니다. 자동으로 로그아웃시키지 않습니다.
> - 처음 쓰는 방의 읽기·전송은 사람이 승인합니다(`ask` 모드 기본값). 시험은 나와의 채팅처럼 직접 정한 방에서 하세요.

## 구성

| 항목 | 내용 |
|---|---|
| 이미지 | `node:22-bookworm-slim` 기반, 이 저장소 소스를 그대로 실행 |
| 데이터 | Docker 볼륨 `kakao-mcp_kakao-data`의 `/data` (`.env.local`과 메시지 저장소) |
| MCP 포트 | 컨테이너 안 `127.0.0.1:8787`. 호스트에 공개하지 않습니다 |
| 웹 화면 | 호스트의 `127.0.0.1:8899`에서만 접속 |
| 격리 | node 사용자, 읽기 전용 루트 파일시스템, 모든 capability 제거, `no-new-privileges` |

명령은 모두 **저장소 루트**에서 실행합니다. 아래에서 `dc`는 `docker compose -f docker/compose.yaml`의 줄임입니다.

```bash
alias dc='docker compose -f docker/compose.yaml'
```

## 1. 빌드하고 시작

```bash
dc up -d --build
dc logs kakao-mcp
```

처음에는 계정이 연결되지 않아 데몬이 대기합니다. 로그에 `아직 카카오 계정이 연결되지 않았습니다.`가 보이면 정상입니다.

## 2. 카카오 계정 연결

```bash
dc exec kakao-mcp kakao-login
```

계정과 비밀번호를 입력하고(비밀번호는 화면에 표시되지 않음), 휴대폰 카카오톡에 뜨는 기기 인증 요청을 직접 승인합니다. 비밀번호는 등록 과정에만 쓰이고 파일에 저장하지 않습니다. 등록된 기기 키와 토큰만 볼륨의 `/data/.env.local`(권한 0600)에 저장됩니다.

연결이 끝나면 데몬을 시작합니다.

```bash
dc restart kakao-mcp
dc logs -f kakao-mcp
```

## 3. 터미널에서 확인

```bash
dc exec kakao-mcp kakao status        # 연결 상태
dc exec kakao-mcp kakao list          # 대화방 목록
dc exec -it kakao-mcp kakao chat      # 터미널 메신저
```

## 4. AI 클라이언트 연결

AI 클라이언트가 `docker exec`로 컨테이너 안의 커넥터를 실행해, 컨테이너 안의 loopback 포트로만 데몬에 붙습니다.

```bash
# Claude Code
claude mcp add kakao-mcp -- docker exec -i kakao-mcp kakao-connect

# Codex
codex mcp add kakao-mcp -- docker exec -i kakao-mcp kakao-connect
```

AI 클라이언트를 다시 시작한 뒤 "카카오톡 연결 상태를 확인해 줘", "나와의 채팅에 테스트 메모를 보내 줘"처럼 요청합니다. 처음 쓰는 방은 확인 창에서 승인합니다.

## 5. 웹 화면

```bash
dc exec kakao-mcp kakao-web
```

터미널에 나온 `http://127.0.0.1:8899/launch?t=...` 링크를 같은 컴퓨터의 브라우저에서 엽니다. 링크는 실행할 때마다 바뀌고, 그 링크로 연 탭에서만 동작합니다. 종료는 Ctrl-C입니다.

## 운영 명령

| 하려는 일 | 명령 |
|---|---|
| 로그 보기 | `dc logs -f kakao-mcp` |
| 중지 / 다시 시작 | `dc stop` / `dc start` |
| 코드 갱신 후 다시 빌드 | `git pull` 후 `dc up -d --build` |
| 도구 묶음 켜기 | `dc exec kakao-mcp sh -c 'echo KAKAO_MCP_TOOL_GROUPS=chats,friends,events,vault >> /data/.env.local'` 후 `dc restart kakao-mcp` |
| 컨테이너만 삭제 (계정 데이터 유지) | `dc down` |
| 계정 데이터까지 모두 삭제 | `dc down -v` |

- 데몬을 다시 시작하면 실행 중에 건 일시정지(`pause`)가 풀립니다. 작업 상태를 확인한 뒤 다시 시작하세요.
- `dc down -v`는 기기 키·토큰·저장된 메시지를 지웁니다. 다시 쓰려면 2단계부터 새로 연결합니다.

## 보안 메모

- MCP 포트는 호스트에 공개하지 않습니다. `compose.yaml`의 `ports`에 8787을 추가하지 마세요.
- 웹 화면은 호스트의 loopback(`127.0.0.1`)에만 공개합니다. `0.0.0.0`으로 바꾸지 마세요.
- 볼륨의 데이터는 암호화되지 않습니다. Docker를 쓸 수 있는 사용자(docker 그룹 포함)는 볼륨과 컨테이너 안을 모두 볼 수 있으니, 혼자 쓰는 컴퓨터에서 시험하세요.
- AI 클라이언트에 셸 권한이 있으면 `docker exec`로 커넥터를 직접 열어 확인 창에 스스로 답할 수 있습니다. 사람 승인을 분리하려면 [패스키 승인](passkey-approval.md)을 설정하세요.
