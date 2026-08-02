# 요청·결과 목록 삭제 기능 패치

## 추가 기능

- 각 작업 카드에 `목록에서 삭제` 버튼 추가
- 화면 상단에 `목록 전체 비우기` 버튼 추가
- 삭제 전 확인창 표시
- 현재 브라우저의 작업 목록(localStorage)에서만 제거
- Supabase에 저장된 특허 데이터와 PDF 원본은 유지

## 적용

1. 실행 중인 웹사이트 터미널에서 `Ctrl + C`
2. `apply_job_list_delete_patch.bat` 실행
3. 웹사이트 재실행

```powershell
cd C:\Users\USER\kipris-public-platform
.\start_web.bat
```

4. 브라우저에서 `http://localhost:3000/jobs` 접속 후 `Ctrl + F5`

## 참고

이 기능은 불필요한 카드만 현재 브라우저의 요청·결과 목록에서 숨기는 안전한 정리 기능입니다.
Supabase 데이터베이스 및 Storage PDF를 삭제하지 않습니다.
