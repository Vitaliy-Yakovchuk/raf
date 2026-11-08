# Живий стан після 1.1.14, до активації lease-фіксу 1.1.15

Main повідомив активну ревізію b24cb2117bb8ca4ba9f59a9dcec0d2400ce6e3cf (містить e90c0d6). main-wall.txt скопійований з доказу main у OpenSpec: 5 послідовних ps 868–1306 мс, медіана1245 >1000; reminder list --to main 335–442, медіана382 <500; help88–115. Виконавець не перезапускав живий сервіс і не створював нових живих агентів.

observed-launches.json та незмінені *.jsonl — read-only спостереження ~/.raf/tmp/*/launch-timeline.jsonl після12:00 UTC 2026-11-08. wallMs — cli-response-flushed мінус cli-start (не shell wall); runnerMs — readiness+delivery; overheadMs=wallMs-runnerMs. Результати не позначаються холодними: статус compile-cache/service restart невідомий. Нових запусків заради повторів немає.

Run8d014711 включає очікування admission (~570с), тому не є виміром uncontended overhead. Наступні fb546f82/ec635517/58f67dbe/50a5bed1 мають overhead4637/3293/3173/2930мс, settle191/77/48/57мс. Позначки показують зменшення settle порівняно з 1.1.13, але не підтверджують загальний бюджет <3с. Зовнішні readiness/delivery виключено; жодного нового ліміту/таймауту не введено. Холодних і теплих контрольованих повторів після1.1.15 ще немає; це робота main після активації.
