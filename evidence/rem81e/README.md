# add-raf-reminders:8.1 — agent interrupt

Аудит 2026-10-25: задача актуальна, відповідає delta `openspec/changes/add-raf-reminders/specs/projects/raf/agent-control/spec.md`, вимозі «Штатне закриття та переривання» та сценарію «Переривання дії». Runtime містив безумовний `INTERRUPT_UNAVAILABLE`. Нових вимог або послаблення тестів немає.

Наявні п’ять регресій збережені. Додано тест невідомого екрана з composer. Спочатку виконано власний red, потім додано тест і повторно підтверджено red до реалізації. Виправлення перевіряє свіжу identity, boot/machine та належність recorded pane; надсилає один Escape лише за native busy evidence. Після клавіші в межах transitionMs із конфігурації підтверджує idle composer і той самий живий процес. Не закриває сесію, не звільняє reservation і не змінює нагадування. Непідтверджений перехід повертає INTERRUPT_UNCONFIRMED.

Префікс усіх прогонів: `node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/3557f6a4-89a2-41a3-b963-b4343aabc699/raf-main/bin/raf.ts`.

| Доказ | Аргументи після префікса | runId | Outcome / CLI / child |
| --- | --- | --- | --- |
| [Початковий red](red-result.json), [CLI](red-cli.json), [stderr](red-stderr.txt) | `test run --project raf --phase red --group add-raf-reminders/unit --files test/session-recovery-interrupt.test.ts` | a56a4857-fb2e-4d5b-834c-a84f713e6a20 | assertions-failed / 1 / 1; 5 knownRed |
| [Red доданої регресії](red-expanded-result.json), [CLI](red-expanded-cli.json), [stderr](red-expanded-stderr.txt) | та сама команда red | 6868a910-1256-40dc-a210-65e3b3d22a81 | assertions-failed / 1 / 1; 6 knownRed |
| [Hotfix](hotfix-result.json), [CLI](hotfix-cli.json), [stderr](hotfix-stderr.txt) | `test run --project raf --phase hotfix --group add-raf-reminders/unit` | 2328dbec-24dc-4203-9e44-4b6b08fbf95a | passed / 0 / 0; 20 passed, 0 knownRed |

Повні TestRunResult збережені без перетворення. Інструмент повернув повний одиничний JSON без додаткового stderr; stderr-файли порожні. CLI exit code збережений окремо від child exitCode. Джерело доручення — add-raf-reminders:8.1, target group — add-raf-reminders/unit; це власна зміна, декларація regressionGroups також є у вибраному item.

В усіх трьох прогонах timedOut=false, cleanup.complete=true, remainingPids=[], unexecuted=[], unknown=[], timeoutCount=0. Red: groupSnapshot=loaded, groupState=idle, nextAction=implement. Hotfix: groupSnapshot=loaded, groupState=complete, nextAction=complete. Група та QA HOME стабільні між фазами. Hotfix використовує весь preset: test/reminder-active-update.test.ts і test/session-recovery-interrupt.test.ts.

Red HEAD: a711b8863c9cffed5ded36f11e730c836fe6a979; паралельні незакомічені правки 5.8 описані в [red-workspace.json](red-workspace.json). Точний історичний dirty snapshot не збережений; interrupt-заглушка не змінювалася. Hotfix HEAD: 6bfd2f03a47e1579584ca74dcba7697d50a62304 плюс три власні файли, їхні SHA-256 та стан дерева — [hotfix-workspace.json](hotfix-workspace.json). Редагування production-runtime узгоджене з raf-prp58-hotfix через agent message після його коміту; cached ps не використовується interrupt-перевірками.

[Збірка](build.json): node scripts/build.ts, exit 0; включає comment-free перевірку. Запуск із окремим HOME /tmp/rem81e-build-home; unit-прогони виконані лише довіреним test run в ізольованому QA HOME. git diff --check для власних файлів — 0.

Межі доказу: це unit-регресія з фейковими process/tmux ports, а не живий QA на провайдері. Main виконує push/активацію окремо. Інші відкриті пункти зміни, зокрема 2.3, не виконувалися; archive не застосовується. Галочку 8.1 ставить raf за succeeded JSON.
