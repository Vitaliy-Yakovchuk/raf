# add-raf-test-run:6.3.6

Виправлено завантаження довіреного Vitest runner з покоління всередині `.git`.
Vite `server.fs.deny` містить `**/.git/**` і перевіряється раніше за `fs.allow`, тому наявне додавання runner до allow не допомагало. Приватна копія runner створюється в TMPDIR прогону; вихідний файл і конфіг deny не змінюються. Копія видаляється після закриття Vitest або помилки створення API. Reporter залишається в поколінні (його Vitest завантажує іншим шляхом).

## Test-first і фактичний результат

База всіх перевірок: raf-hotfix `032580ec15c2d1cdb96b48cd71b96aceec6e31c9`. [Provenance](provenance.json) і patch-файли фіксують незакомічені зміни. Залежності raf були доступні через створений для перевірки symlink node_modules на raf-develop/node_modules; продуктивний HOME не використовувався.

Команда red:

```sh
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/2b9fd73e-6569-4271-bdf8-ffdeea037e81/raf-main/bin/raf.ts test run --project raf --phase red --group add-raf-test-run/etchly-profiles --files test/test-run-etchly-profiles.test.ts
```

Перший виклик [64f057b0](red-refused.result.json): RESOURCE_UNAVAILABLE до spawn, CLI 1 / child null. Це відмова, не red. Повтор після зниження навантаження: [f61c287e](red.result.json), assertions-failed, 83 passed / 4 knownRed; дві нові перевірки staging падають твердженням про відсутню поведінку. Setup/import failure не зараховувався як unit-red.

Команда підтвердження — дослівно та сама, з `--phase hotfix`: [d7dfe89e](hotfix.result.json), 85 passed / 2 knownRed; обидві власні регресії пройшли. Загальний outcome залишається assertions-failed, CLI 1 / child 1. Це НЕ повністю зелена група. Для всіх unit-викликів є повний незмінений TestRunResult, окремі `*.stderr` і `*.cli.json`; SHA/dirty — у provenance та patch-файлах. CLI видав повний JSON без додаткового stderr у транспорті.

Спільний стабільний HOME/агрегат у всіх викликах: `/tmp/raf-unit-1000/1ee10007bf6d5e71b39d6a2873064a767eeb928e7910599b166a0d60270ff685`. Група не перейменовувалася, knownRed не скидалися. Таймаутів 0; cleanup.complete=true, remainingPids=[], unexecuted=[], unknown=[] у виконаних red/hotfix. Стан групи idle, наступна дія fix-implementation щодо залишку.

Залишок — два наявні тести `full-suite-explicit refuses before Etchly browser-cache preflight failure` і `valid subset retains Etchly browser-cache preflight failure`: рядок 577 очікує result.command === null, хоча production уже записує команду до preflight. Вони падали до зміни production. Main виділив їх в окремий відкритий **6.3.6.1 [test-scaffold]** і доручив звітувати 6.3.6 з точним залишком. Ці тести та інша production-логіка не змінювалися.

## Ізольоване відтворення й стендова регресія

```sh
node scripts/qa-test-run-generation-stand.ts red evidence/hotfix-6.3.6/stand-red
node scripts/qa-test-run-generation-stand.ts hotfix evidence/hotfix-6.3.6/stand-hotfix
```

Це окрема локальна стендова перевірка, не unit-виняток. Вона використовує встановлені etchly-develop Vitest/Vite/happy-dom, синтетичний власний файл і приватні HOME=RAF_QA_HOME та TMPDIR, а не чужу продуктову групу. Загальний deadline береться з конфігурації; усі дочірні групи процесів і власна fixture очищуються.

[До виправлення](stand-red/summary.json): прямий Vitest happy-dom — exit 0; міст API з копії покоління `.git/modules/raf/hotfix/generations/one/raf-main` — exit 1 з ERR_MODULE_NOT_FOUND/test-run-vitest-runner.ts у [повному протоколі](stand-red/generation-happy-dom-wrapped.protocol). Стендовий драйвер — exit 0, тобто цільову помилку відтворено; цей setup failure не підміняє unit-red.

[Після виправлення](stand-hotfix/summary.json): 4/4 комбінації generation/ordinary × happy-dom/node пройшли; кожна має прямий baseline exit 0 і адаптер exit 0, один passed і complete з одним очікуваним тестом. Усі timeout=false, cleanup=true, fixtureRemoved=true; stdout/stderr/protocol збережені окремо для кожного child. Код обох викликів драйвера — 0.

[Статичні перевірки](static.json): синтаксис чотирьох змінених файлів, check-comments та diff-check — exit 0. Галочки tasks.md не змінювалися. Інші пункти відкриті, archive/sync не виконуються. Push і активація main не виконувалися.
