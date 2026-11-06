# 2.37.1 — local SQLite proxy tests

Джерело очікувань: design.md:94–96, пізніше рішення main про local SQLite; воно уточнює попередній текст NVISIT у design/delta. Production-код і чужі правки не змінено. Нової публічної поверхні немає, новий каркас не потрібен.

Тести перевіряють proxy max(returnedRows, FULLSCAN_STEP + 1), компоненти метрики, межі fullscan 49/50/51, прямі all/get/iterate/run/exec. Приховане indexed COUNT не заявляється як виміряні visits; результат 80 лишається доступним із proxy 1. Прибрано вимоги виявляти приховані indexed filter/join. Виправлено fixture transaction(tx => tx.listPending()) та додано обґрунтовану межу 100 лише для DROP TABLE, який переглядає 51 рядок каталогу.

Первинний RED: bf36cbdb-31b8-471b-ae90-1865d566b221; 35 passed, 6 assertions-failed, CLI/child exit 1, без setup/import, timeout=false, cleanup complete. Усі 6 тверджень падають на рівності формулі proxy: поточна паралельна реалізація повертає 0 коли fullscanSteps=0 та returnedRows=0, тоді як буквальна формула design дає 1. Основний окремий regression — empty point lookup; решта п’ять застосовують той самий інваріант до реальних сховищ/міграцій. Це передано main для перевірки; не видається за NVISIT або прихований scan. Новий запуск не робився заради повного stderr.

Стабільна група: limit-db-rows-read-per-query/raf; точна команда в run-metadata.json. Група та unitFiles вже зареєстровані; conf не змінено. Інші автори розширюють відбір цієї групи, тому використано явний --files для власного тесту. Наступному етапу передається та сама група. Повний TestRunResult.json, transcript, stderr та CLI code збережені; transcript не обрізаний, stderr виділено з combined output. Runner уже редагує/знеособлює діагностику (redacted=true, truncated=false).

Галочки tasks.md не змінено, інші задачі відкриті; archive/push не виконано.

Після RED реалізатор повідомив про виправлення формули за уточненням main; первинний RED лишається доказом стану на момент запуску. Доданий пояснювальний // коментар прибрано за comment-policy; поведінка тестів незмінна. Фінальний GREEN виконує implement. SHA256 у run-metadata стосується точного тесту первинного RED до видалення цього коментаря.
