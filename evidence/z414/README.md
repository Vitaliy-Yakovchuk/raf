# Z.414: підтвердження галочки після архівації

Доручення актуальне: сценарій фінальних комітів архівації вимагає повторного підтвердження того самого джерела після перенесення активної зміни. Виправлення зберігає ідентичність джерела, provenance поточного запуску та точний рядок із галочкою.

## Що відтворено

Main надав хронологію dash-dba51-spec: checkbox fc765911b0, archive c8e3beafa5, відмова ENOENT активної теки. Історичний фінальний JSON видалений, його archive claim невідомий. Це unit-відтворення зі справжніми Git, SQLite, adapter identity та report reader; лише відповіді OpenSpec замінені fixture. Це не повторний запуск історичної сесії.

До виправлення фінальний звіт із явним правильним archive claim уже проходив. Точний ENOENT відтворився у вікні після переміщення теки, до атомарного доповнення JSON claim. Другий assertion-red виявив прийняття зміненого raw рядка в архіві. Обидва падіння зафіксовані до змін production-коду. Тести також перевіряють відсутній архів, змінений опис, незакриту галочку, скопійоване джерело, архів до запуску, неправильний claim і чужий journal.

Тепер повторне підтвердження знаходить єдиний відповідний архів, перевіряє точний рядок та початковий marker-only checkbox commit. Без claim залишається awaitingArchive; фінальний звіт приймається після точного claim. Новий checkbox commit при цьому не створюється. Перевірки ідентичності до і після операції збережені.

## Результати

| Прогін | Run ID | Результат | CLI / child | Група / наступна дія |
| --- | --- | --- | --- | --- |
| red z414 | 67614deb-2c63-4b23-9218-184cd5785037 | assertions-failed: 8 passed, 2 knownRed | 1 / 1 | idle / implement |
| hotfix z414 + checkbox report/index | 936ca20e-d18a-417c-b389-bbc794f6458c | passed: 70 | 0 / 0 | complete / complete |
| hotfix z412 (повний preset) | 5ceb296f-3957-4452-b7f4-b8aced3b2f79 | passed: 91 | 0 / 0 | complete / complete |

Усі cleanup.complete=true, remainingPids=[], timedOut=false, timeoutCount=0. Unexecuted та unknown порожні. Після hotfix knownRed порожній. Агрегат z414 і QA HOME збережені між red/hotfix; розширення відбору додало файли до того самого --files. Build та check:comments виконані в тому самому ізольованому QA HOME, обидва exit 0. git diff --check також exit 0.

[manifest.json](manifest.json) містить точні команди, відбір, SHA та посилання на незакомічені workspace patches/status, повний незмінений TestRunResult, окремі CLI exit status, stderr і tool captures. Z412/build/check виконані на тому самому workspace, що й hotfix; після нього код не змінювався. Наявний untracked node_modules не належить цій роботі.

У complete-raf-flow-contracts є інші відкриті пункти. Виконано лише Z.414; checkbox доручення залишено raf, архівацію зміни не виконано.
