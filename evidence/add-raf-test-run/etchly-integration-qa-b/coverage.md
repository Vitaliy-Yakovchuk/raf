# Межі D01–D09

Це адресна карта перевірки, не заміна виконання. Файл `test/test-run-etchly-integration.test.ts` містить unit-контракти нижче. Перший спостережений unit passed мав урізаний capture; дозволений повтор збережено повністю, але він setup-failed до spawn. Тому жоден рядок нижче не оголошує підтвердженого unit-green.

| ID | Адреса автоматичного контракту | Живий доказ у цьому запуску |
|---|---|---|
| D01 | test/test-run-etchly-integration.test.ts:38 — adapter/exactIds, Node integration і legacy unit | Не підтверджено; окремі same-change регресії ще не виконані |
| D02 | :65, :71, :75, :251, :273 — класифікація, stale paths, import drift, missing inventory | Лише read-only context/source hashes; поведінковий результат відсутній |
| D03 | :80, :90, :96, :103, :107 — preset/exact files, відмови та argv | Підготовлено host smoke, очікуються повні captures |
| D04 | :107, :121, :126 — integration budget і збереження deadline | Підготовлено host D08 з окремою явно записаною stand policy |
| D05 | :140, :145, :149, :152 — ізоляція, залежності, credentials/build guard | Статична наявність dependencies/build; живий setup не підтверджено; host smoke включає missing-build/workerd |
| D06 | :189, :198, :208, :280, :287 — origin, повнота, skip/lost protocol, diagnostics | Host D08 перевіряє green/assertions/import/skip; global-setup/hook/zero-tests/lost protocol лишаються unit-контрактами без власного підтвердженого виконання |
| D07 | :166, :171, :176, :180, :184 — own caller і відмови | Immutable assignment project=raf; own etchly authorization не одержано. Host API context синтетичний і цього не доводить |
| D08 | :208, :228, :236, :240, :244 — cleanup/recovery/concurrent | Скрипт передано main для першого реального host-виконання; поки не виконано |
| D09 | Не є unit-сценарієм; etchly smoke через довірений канал самого QA | Не виконано: потрібні належне project=etchly доручення й сумісний канал. Main-executed host API smoke не замінює цей критерій |

Не виконані same-change unit-регресії: `add-raf-test-run/etchly-profiles` (`test/test-run-etchly-profiles.test.ts`) і `add-raf-test-run/integration-profiles` (`test/test-run-integration-profiles.test.ts`, `test/test-run-integration-runtime.test.ts`). Для foreign change декларації regressionGroups немає; чужі тести/задачі не виконувалися й не закривалися.
