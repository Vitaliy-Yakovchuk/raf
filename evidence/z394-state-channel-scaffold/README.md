# Z.394.1 — unit-стик production launch → host → result

Підготовлено шість unit-тестів у `test/sandbox-state-channel-z394.test.ts` та окремі моки у `test/support/sandbox-state-channel-z394-mocks.ts`. Нової production-поверхні немає, тому каркас із `NotImplemented` не потрібний. Production і tasks.md не змінено.

Фінальний авторський прогін: `07-final.TestRunResult.json`, runId `4f824f78-ecda-4717-87a2-72413b81d5a6`, `phase=red`, `callerPhase=test-scaffold`, CLI 0, `passed` 6/6, `knownRed=[]`, `unknown=[]`, `unexecuted=[]`, cleanup complete. Це **existing-green**, не behavioral red і не доказ завершення live QA. Повний TestRunResult, діагностичний stderr черги й CLI metadata збережено без скорочення.

## Інваріанти й reuse

| Сценарій | Нові assertions / чинний власник решти |
| --- | --- |
| S01 | Три проходи через справжній `runProductionWorker` → `prepareCodexRafCommandAccess` → незмінені generated hook/replay → `runPublishedAgentChannel`: ps, message, test run. Production передає точні publication caller/HOME/cwd, state-deny scope та hooks у runner invocation. SQLite/WAL/SHM отримують EACCES у sandbox filesystem-порту; перевірений host відкриває свій state context. stdout/stderr/code, включно з nonzero 17, збережені точно; один host invocation і один generation spawn. |
| S02 | Додано лише adapter delivery test run. Control/unit paths, phase/assignment authorization, stateAccess і recovery належать 5.10 / author-red / sandbox-test-run. Тут повертається тестовий payload; це не вкладений справжній unit-прогін. |
| S03 | Production prepare failure передається без зміни причини, до wrapper/runner/tmux і доставки брифа; cleanup відбувається. Protocol/native lifetime/effective timeout — reuse `test/codex-raf-command-lifetime.test.ts`, add-raf-test-run 6.3.12. |
| S04 | Інжектована втрата publication після закриття host child: reader повертає nonzero, повідомляє про відсутність retry, не повертає original command і не запускає другий host/generation. Admission owner lifetime та ledger recovery — reuse 6.3.12/5.10. |
| S05 | У production-підключенні hook допускає лише виданий prefix/subcommand: env/cd/pipe/chain/substitution/інший entrypoint/невидана команда не мають host invocation; буквальне еквівалентне quoting працює. Повні parser/output, secrets, endpoints і OS sandbox checks — reuse чинного adapter/output/channel покриття та окремий live QA, не дублюються тут. |
| S06 | Повторне використання 5.10 state-open-recovery; нових role/path/native-cause/recovery assertions немає. |

Unit-межі: справжня production композиція та generated scripts виконуються з окремими in-memory state/OS/process/inspector doubles. Окремі власні capture-файли створюються лише у приватному TMPDIR. Доступ до робочих SQLite/WAL/SHM, Codex, tmux, credentials, мережі та робочого HOME не потрібний. EACCES тут забезпечує mock filesystem-порт на основі виданого production scope; фактичне OS enforcement залишається предметом live QA.

## Inventory та передумови для наступних стадій

Стабільна група: `complete-raf-flow-contracts/z394`; рівно один unit file: `test/sandbox-state-channel-z394.test.ts`. Support-файл не реєструється як unit entrypoint. Main підтвердив реєстрацію до red в Orchestrator `b1ca8e7cf5`; конфігурація повторно прочитана й збігається:

```json
{
  "unitFilesAppend": {
    "/projects/raf/profiles/node/unitFiles": ["test/sandbox-state-channel-z394.test.ts"]
  },
  "groupsSet": {
    "/projects/raf/groups/complete-raf-flow-contracts~1z394": {
      "profileId": "node",
      "files": ["test/sandbox-state-channel-z394.test.ts"]
    }
  }
}
```

Профіль `node`: Node >=25.4.0 із TypeScript stripping та synchronous registerHooks; перевірки `node_modules/typescript/package.json`, `src/test-run-reporter.ts`, `scripts/test-run-node.ts`; `environment.isolatedHome=true`, `environment.stateOrigin=true`; чинні conf/raf.json, conf/test-runs.json та conf/flow.json. Timeout береться лише з `conf/flow.json#/unitTests/timeoutMs`. Linux файловий replay використовує `/proc/self/fd`; потрібний лише власний тимчасовий каталог. Прогін перевірено на Node v26.12.1. Фази не змінюють group або QA HOME.

```sh
raf_command test run --project raf --phase red --group complete-raf-flow-contracts/z394 --files test/sandbox-state-channel-z394.test.ts
```

Наступна стадія зберігає той самий group/files і використовує свою дозволену phase. Ніякого reset ledger, нового unit HOME або ручного knownRed не виконано.

## Попередні відмови fixture

Перші п'ять прогонів не є behavioral red. Власні setup/driver помилки виправлені: форма ps observation, metadata сокета, module exports та об'єкти stdout/stderr замість Node streams. Повні доступні результати збережені як `01`, `03`, `04`, `05`; для другого прогону (`e7739bda-b4e8-42d4-9f7f-21fa2e1d8813`, CLI 1, assertions-failed, malformed process ancestry) повний capture не збережено. Жоден із них не використовується для твердження про production дефект. `06` — перший green після виправлення streams, `07` — повторний green після фіналізації assertions прямого deny.

Старе формулювання пункту про заборону читання/прогону уточнено чинним дорученням: «Можна читати код проєкту для авторства тестів і каркаса; сам підтвердь власний первинний red через дозволений raf test run --phase red». Очікування взято з повних двох вимог agent-adapters та S01–S06 дизайну, а код/інші тести використано для підключення реальних портів і карти reuse. Нового дефекту ці приймальні тести не виявили. Інші пункти зміни відкриті; archive не виконується.
