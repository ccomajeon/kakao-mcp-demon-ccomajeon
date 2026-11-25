# Docker로 로컬에서 시험하기

내 컴퓨터(macOS·Windows·Linux)의 Docker에서 데몬 하나를 띄워 AI·터미널·웹 화면을 시험하는 방법입니다. systemd 설치 대신 컨테이너 안에서 데몬을 직접 실행합니다. **Docker 구성은 시험용입니다.** 아래 [보안 메모](#보안-메모)처럼 AI 클라이언트와 데몬이 분리되지 않으니 계속 쓰는 설치에는 쓰지 마세요. 운영 서버 설치는 [README의 설치와 사용법](../../README.md#설치와-사용법)을 따르세요.

> **먼저 알아둘 점**
> - 비공식 클라이언트라 카카오 계정 제재 위험이 있습니다. 시험용 계정이나 위험을 받아들인 계정으로 하세요.
> - 다른 PC가 같은 계정을 쓰고 있으면 로그인이 중단될 수 있습니다. 자동으로 로그아웃시키지 않습니다.
> - 처음 쓰는 방의 읽기·전송은 사람이 승인합니다(`ask` 모드 기본값). 시험은 나와의 채팅처럼 직접 정한 방에서 하세요.

## 구성

| 항목 | 내용 |
|---|---|
| 이미지 | `node:22-bookworm-slim` 기반 2단계 빌드. 실행 이미지에는 운영 의존성과 컴파일된 protocol만 넣고 패키지 설치 스크립트를 실행하지 않음 |
| 데이터 | Docker 볼륨 `kakao-mcp_kakao-data`의 `/data` (`.env.local`과 메시지 저장소) |
| MCP 포트 | 컨테이너 안 `127.0.0.1:8787`. 호스트에 공개하지 않습니다 |
| 웹 화면 | 호스트의 `127.0.0.1:8899`에서만 접속 |
| 격리 | node 사용자(uid 1000), 읽기 전용 루트 파일시스템, 모든 capability 제거, `no-new-privileges`, 메모리 512MB·프로세스 128개 상한 |
| 재시작 | 비정상 종료 시 최대 3번까지만 다시 시작(`on-failure:3`) |
| 상태 검사 | `kakao-health`가 1분마다 데몬에 `get_status`를 물어 세션 연결 여부를 확인. 토큰·계정 ID는 출력하지 않음 |

명령은 모두 **저장소 루트**에서 실행합니다. 아래에서 `dc`는 `docker compose -f docker/compose.yaml`의 줄임입니다.

```bash
alias dc='docker compose -f docker/compose.yaml'
```

## 1. 빌드하고 시작

```bash
dc up -d --build
dc logs kakao-mcp
```

처음에는 계정이 연결되지 않아 데몬이 대기합니다. 로그에 `아직 카카오 계정이 연결되지 않았습니다.`가 보이면 정상입니다. 이때 `docker ps`의 상태는 `unhealthy`로 표시됩니다(아직 세션이 없으므로).

## 2. 카카오 계정 연결

```bash
dc exec kakao-mcp kakao-login
```

계정과 비밀번호를 입력하고(비밀번호는 화면에 표시되지 않음), 휴대폰 카카오톡에 뜨는 기기 인증 요청을 직접 승인합니다. 비밀번호는 표준 입력으로 등록 과정에만 전달되고(명령 인자나 환경 변수에 넣지 않음) 파일에 저장하지 않습니다.

볼륨의 `/data/.env.local`(권한 0600)에는 기기 키(device UUID), 접근·갱신 토큰, 카카오 사용자 ID, 입력한 계정(이메일 또는 전화번호), 기기 이름이 저장됩니다. 비밀번호는 저장하지 않습니다. 이 파일만으로 계정에 접속할 수 있으니 복사하거나 공유하지 마세요.

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
| 도구 묶음 켜기 | 아래 예시 참고. 필요한 묶음만 켜고 `dc restart kakao-mcp` |
| 컨테이너만 삭제 (계정 데이터 유지) | `dc down` |
| 계정 데이터까지 모두 삭제 | `dc down -v` |

- 데몬이 비정상 종료하면(예: 다른 PC 세션 때문에 로그인이 거절됨, 토큰 만료) 3번까지만 다시 시작한 뒤 멈춥니다. `dc logs kakao-mcp`로 원인을 확인하고, 다른 PC 세션을 정리하는 등 원인을 해결한 뒤 직접 `dc start`로 시작하세요.
- 걸어 둔 일시정지(`pause`)는 데몬을 다시 시작해도 유지됩니다. 해제는 사람 승인으로만 됩니다.
- `dc down -v`는 기기 키·토큰·저장된 메시지를 지웁니다. 다시 쓰려면 2단계부터 새로 연결합니다.

도구 묶음은 `KAKAO_MCP_TOOL_GROUPS` 한 줄로 정합니다. 필요한 묶음만 적고, 이미 줄이 있으면 덧붙이지 말고 바꿉니다.

```bash
# 예: chats와 friends만 켜기. 기존 KAKAO_MCP_TOOL_GROUPS 줄을 지우고 한 줄만 남깁니다.
dc exec kakao-mcp sh -c 'umask 077; f=/data/.env.local; grep -v "^KAKAO_MCP_TOOL_GROUPS=" "$f" > "$f.tmp"; echo KAKAO_MCP_TOOL_GROUPS=chats,friends >> "$f.tmp"; mv "$f.tmp" "$f"'
dc restart kakao-mcp
```

## 보안 메모

- MCP 포트는 호스트에 공개하지 않습니다. `compose.yaml`의 `ports`에 8787을 추가하지 마세요.
- 웹 화면은 호스트의 loopback(`127.0.0.1`)에만 공개합니다. `0.0.0.0`으로 바꾸지 마세요.
- 볼륨의 데이터는 암호화되지 않습니다. Docker를 쓸 수 있는 사용자(docker 그룹 포함)는 볼륨과 컨테이너 안을 모두 볼 수 있으니, 혼자 쓰는 컴퓨터에서 시험하세요.
- **`docker exec` 연결에서는 AI 클라이언트와 데몬이 분리되지 않습니다.** AI 클라이언트를 실행하는 OS 사용자가 Docker를 쓸 수 있어야 하므로, 셸 권한이 있는 AI가 받은 메시지 등에 속아(prompt injection) `docker exec`로 컨테이너에 들어가면 `/data/.env.local`의 토큰과 설정을 읽고, `KAKAO_AGENT_MODE`를 `trust`로 바꾸고, 승인 상태 파일을 고칠 수 있습니다. [패스키 승인](passkey-approval.md)도 이 경우를 막지 못합니다(설정과 승인 파일을 같은 방법으로 바꿀 수 있음). 그래서 Docker 구성은 시험용으로만 쓰고, 계속 쓰는 설치는 AI와 다른 OS 사용자로 데몬을 실행하는 [README의 설치](../../README.md#설치와-사용법)를 따르세요.
- Linux에서 Docker를 직접 쓰면(Docker Desktop이 아닌 경우) 컨테이너의 node 사용자는 호스트의 uid 1000과 같은 사용자로 취급됩니다. 호스트에서 uid 1000으로 실행되는 프로세스는 `/proc`을 통해 컨테이너 프로세스의 메모리·환경 변수와 열린 파일(토큰 포함)을 읽을 수 있습니다. 호스트의 uid 1000 사용자를 믿을 수 없는 컴퓨터에서는 쓰지 마세요.
