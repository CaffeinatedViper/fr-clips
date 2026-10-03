# FR Clips

Francuski z filmików YouTube, na telefon (PWA).

1. **Powtórka:** fiszki w algorytmie FSRS (ts-fsrs, w `vendor/`).
2. **Filmik:** wklejasz link (albo YouTube → Udostępnij → FR Clips). Gemini ogląda film i proponuje zwroty z tłumaczeniem w kontekście i znacznikiem czasu.
3. **Wybór:** zaznaczasz do 8 zwrotów, które trafiają do talii.

Klucz Gemini (darmowy, aistudio.google.com/apikey) i talia są tylko w pamięci telefonu (IndexedDB). Kopia zapasowa: Ustawienia → Zapisz kopię.

Bez builda: same pliki statyczne. Lokalnie: `python -m http.server 5173`.
Po zmianie plików podbij `CACHE` w `sw.js`.
