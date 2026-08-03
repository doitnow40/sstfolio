# SSTfolio v2.0

SSTfolio v1.0을 변경하지 않고 별도 배포하기 위한 v2.0 패키지입니다.

## 핵심 변경

- `portfolio_data`는 `scripts/fetch_naver.py`만 작성합니다.
- Worker는 KV miss 시 GAS 가격을 캐시하지 않고 HTTP 503을 반환합니다.
- 각 보유종목에 `price_updated_at`, `price_status`, `price_source`, `price_error`를 기록합니다.
- 실패 종목은 기존 v2 KV의 마지막 정상 가격을 유지합니다.
- `emergency_full`은 전체 종목을 다시 조회하고 성공률 95% 이상일 때만 KV를 교체합니다.
- GAS의 직접 가격 조회 함수는 GitHub Actions 호출로 위임됩니다.
- v2 브라우저 설정과 로컬 백업은 `sstfolio_v2_*` 키를 사용하여 v1과 분리됩니다.

## 파일

- `index.html`: GitHub Pages 웹앱
- `scripts/fetch_naver.py`: 가격 수집 및 KV 단일 작성자
- `.github/workflows/fetch-realtime.yml`: GitHub Actions. 초기 상태에서는 schedule 비활성
- `cloudflare/sstfolio_worker.js`: Worker API
- `gas/SSTfolio_GAS.gs`: v2 GAS
- `requirements.txt`: Python 의존성
- `docs/`: Word 배포 매뉴얼과 개발 인수인계 문서

## 최초 배포 전 필수

1. 별도 GitHub 저장소, GAS 프로젝트, Cloudflare Worker, KV Namespace를 생성합니다.
2. `index.html`의 `REPLACE_WITH_V2_GAS_EXEC_URL`, `REPLACE_WITH_V2_WORKER_URL`을 바꾸거나 웹 설정 화면에서 입력합니다.
3. GitHub Secrets와 Worker/GAS 변수를 Word 매뉴얼에 따라 설정합니다.
4. v1이 자동 수집 중인 동안 v2 workflow의 schedule 주석을 제거하지 않습니다.
5. GitHub Actions에서 `emergency_full`을 수동 실행하여 최초 `portfolio_data`를 생성합니다.

상세 절차는 `docs/SSTfolio_v2_분리배포_운영매뉴얼.docx`를 참조합니다.

## 로컬 정적/단위 테스트

실제 GAS·Cloudflare·시세 API를 호출하지 않는 테스트입니다.

```bash
python -m py_compile scripts/fetch_naver.py
python tests/test_fetch_v2.py
node --check cloudflare/sstfolio_worker.js
node tests/test_worker_v2.mjs
```
