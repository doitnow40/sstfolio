# SSTfolio v2.0 Release Notes

기준일: 2026-08-02

## 목적

운영 중인 v1.0을 변경하지 않고 별도 v2 환경에서 검증한 뒤 단계적으로 전환하기 위한 전체 배포 패키지입니다.

## 핵심 변경

- `portfolio_data`의 작성자를 Python 수집기 하나로 제한했습니다.
- Worker의 KV miss 시 오래된 GAS 가격을 캐시하지 않고 503으로 명확히 반환합니다.
- Python이 기존 v2 KV의 종목별 마지막 정상 가격을 보존합니다.
- 각 종목에 `price_updated_at`, `price_last_attempt_at`, `price_status`, `price_source`, `price_error`를 기록합니다.
- 장중 오래된 값, 장 마감값, 이전값, 미지원값, 누락값을 구분합니다.
- 장 마감 상태라도 10일 이상 갱신되지 않은 값은 `stale`로 표시합니다.
- 긴급 전체 최신화는 KR/US 전체 지원 티커를 조회하고 성공률 95% 이상일 때만 KV를 교체합니다.
- Naver/Yahoo 응답의 403/429 발생 시 소스별 circuit breaker를 작동시킵니다.
- GAS의 직접 주식가격 수집 및 테스트 함수는 GitHub Actions 위임 또는 비활성화했습니다.
- 보유종목/실현손익/계좌 그룹 변경 시 가격 KV를 삭제하지 않고 `sync` workflow를 요청합니다.
- v2 localStorage 키를 별도로 사용하고 Cloudflare 단기 장애 시 브라우저 마지막 정상값을 명시적으로 표시합니다.
- 테스트 단계에서 v1과 중복 수집되지 않도록 workflow schedule은 기본 주석 상태입니다.

## 배포 전 주의

- `index.html`의 v2 GAS/Worker placeholder를 교체하거나 v2 설정 메뉴에서 URL을 입력해야 합니다.
- v2 GitHub Secrets, Worker Variables/Secrets/KV binding, GAS Script Properties를 매뉴얼대로 설정해야 합니다.
- v1 자동 수집이 동작하는 동안 v2의 schedule을 활성화하지 않습니다.
- GAS 코드를 수정한 뒤에는 새 버전으로 웹앱 재배포가 필요합니다.

## 검증 범위

정적 문법 검사와 외부 API를 사용하지 않는 병합/Worker 단위 테스트를 통과했습니다. 실제 계정의 GAS, GitHub, Cloudflare, Naver/Yahoo를 연결한 통합 테스트는 배포자가 매뉴얼의 최초 검증 절차로 수행해야 합니다.
