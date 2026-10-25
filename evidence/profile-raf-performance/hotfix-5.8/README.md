# profile-raf-performance 5.8: hotfix evidence

Код: `6bfd2f03a47e1579584ca74dcba7697d50a62304`; регресії перед реалізацією: `a711b8863c9cffed5ded36f11e730c836fe6a979`.

Виконано локальне перенесення профілю CPU/wall, production timing та одноразових process scan / SQLite open / production context для agent ps. Точні develop SHA і межі перенесення наведено в [source-provenance.json](source-provenance.json). Збережено наявну hotfix логіку ownership/worker results; спільний process snapshot застосовується до ps. Interrupt має виконувати свіжі перевірки, його інтеграція належить виконавцю 8.1 після нашого коміту.

## Test-first

| Група | red runId | knownRed | hotfix runId | passed |
| --- | --- | ---: | --- | ---: |
| profile | e6fe98e6-3f19-4314-916c-9b485e936cce | 28 | 901d9411-69c4-41bb-994a-b19aa14ae4a1 | 31 |
| timing-coverage | cb84f120-999a-40ec-86fe-e1b2894c3a69 | 61 | 5d7b5447-a019-450d-807b-620a89068675 | 93 |
| agent-ps | f1d3e2c1-0d16-42a3-9cd5-9081f9d7ba25 | 10 | 38ef7899-68f9-42b4-a36c-3f7272244bca | 21 |

Усі три red мають assertions-failed, CLI/child exit 1; hotfix мають passed, CLI/child exit 0. У hotfix knownRed/unexecuted/unknown = 0, timeout = false, cleanup.complete = true, groupState/nextAction = complete; timeoutCount = 0. [runs.json](runs.json) містить повний відбір та стан кожного прогону. Стабільні групи `profile-raf-performance/profile`, `/timing-coverage`, `/agent-ps` і той самий ізольований QA ledger збережені.

Початкова спроба agent-ps `83b57f1a-1d51-4f4a-89fd-29d206d53534` є setup-failed через відсутній main-production-store; це не red. Із develop тестового файла прибрано два unrelated live-harness тести й імпорти, що потребували іншого неперенесеного production-store контракту. Збережено всі 21 адресні тести, включно з QA перевірками SQLite/context. Після усунення setup виконано окремий valid red перед реалізацією.

## Відтворюваність і захоплення

Для кожного прогону `*.TestRunResult.json` містить повний незмінений JSON, `*.tool.json` — повний результат інструмента, `*.combined-stream.txt` — його output, `*.cli.json` — точну команду і CLI exitCode окремо від child exitCode. Інструмент exec_command повертав об'єднаний stdout/stderr: `*.stderr-derived.txt` отримано вилученням рядка TestRunResult. Незалежного захоплення stderr немає; ця межа явно записана в cli.json і не приховується.

[red-workspace.json](red-workspace.json) фіксує початковий HEAD/зміни; [hotfix-workspace.json](hotfix-workspace.json) — HEAD тестового коміту та незакомічений код під час hotfix/build. [code-commit.json](code-commit.json) перевіряє SHA256 усіх 19 власних файлів проти закоміченого коду; [code-commit.patch](code-commit.patch) включає також нові файли. Чужі зміни 8.1 та node_modules не включені до наших комітів.

`npm run build` і `npm run check:comments`: CLI 0, окремі stdout/stderr збережено у build.* / comments.*; виконано з ізольованим HOME. `git diff --check`: 0. Повторного запуску на незмінному коді не проводили.

## Незавершена production частина

ProductionBefore: `6730c74b5ce2fae6b0f7daa05e393c5fa244b423`; productionAfter ще не встановлено. За повідомленням main живий state має schema 16. Перенесений raf_cost_profile потребує schema 17; develop schema 18 належить іншій health зміні та не перенесений. Міграцію та активацію виконує лише main після звільнення DB holders. Обхід міграції не виконували.

Для закриття 5.8 main має зафіксувати production SHA, виконати дозволену міграцію/активацію, живі agent ps і command stats з CLI 0 та перевірити профіль/EMA, результати, SQLite і події. Цих production доказів у виконавця немає, тому повний пункт 5.8 наразі незавершений. Це технічний блокер, а не відмова за рішенням власника. Галочки tasks.md не змінено; інші відкриті пункти зміни не виконували, архівація не застосовується.
