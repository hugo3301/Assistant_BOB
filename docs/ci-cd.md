# CI/CD и настройки GitHub

Репозиторий: https://github.com/hugo3301/Assistant_BOB. Лицензия исходников MIT; Node.js24, npm lockfile. Все actions закреплены полными SHA, их обновления предлагает Dependabot.

## CI

`.github/workflows/ci.yml`: push в main, pull request и ручной запуск. Стандартный ubuntu-24.04 runner, read-only GITHUB_TOKEN, без production-ключей. `npm ci` устанавливает закреплённые зависимости, `npm run ci` проверяет отслеживаемые файлы, Node-тесты, сборку и настоящий workerd/SQLite с подменёнными внешними API. Живые генерации/Telegram/календарные изменения не запускаются.

`check:repo` запрещает типичные runtime/secret-файлы в Git, ищет явные форматы ключей, требует полные SHA в workflows и пустые credential placeholders в .env.example. Это дополнительная проверка, а не гарантия нахождения всех возможных секретов.

## CD

`.github/workflows/deploy.yml` слушает завершение CI и ручной запуск. Публикация разрешена только для hugo3301/Assistant_BOB и main, при repo variable `BOB_CD_ENABLED=true`. Точный immutable SHA берётся из успешного push CI; fork/PR/failed CI не допускаются. Ручной запуск тоже проверяет успешный push CI ровно этого SHA. Если main уже продвинулся, старый commit не публикуется.

Production environment ограничивается main. Единственный постоянный секрет GitHub — отдельный Cloudflare `CLOUDFLARE_API_TOKEN` с Workers Scripts:Edit и Account Settings:Read текущего аккаунта. Он позволяет менять код Worker, поэтому доступом к main/workflows нужно распоряжаться как production-доступом. Ключи Telegram/AI/Google/календарного шифрования в GitHub не передаются.

`deploy-ci.mjs` проверяет свежий CI receipt, чистый tracked checkout, текущий main и ожидаемые name/account из wrangler.jsonc. Wrangler публикует только код с `--keep-vars`, без `--secrets-file`: прежние Worker secrets сохраняются. BUILD_COMMIT содержит SHA выпуска. После deploy проверяются health с этим SHA, открытая регистрация/Mini App и отказ401 без авторизации к приватному API. Генераций и сообщений нет.

Для включения CD нужны настроенные environment secret и BOB_CD_ENABLED. До этого deploy job пропускается. Срок конкретного ключа и результаты настоящих runs фиксируются после настройки; наличие YAML само по себе не означает работоспособный CD.

Netlify-мост публикуется отдельно вручную: каждая production-публикация расходует15credits Free. Его GigaChat/shared secrets уже на Netlify; PAT публикации после проверки отозван. В CD Worker не нужно снова публиковать мост или переносить его ключи в GitHub.

## Бесплатность

Репозиторий публичный. [Стандартные GitHub-hosted runners бесплатны для публичных репозиториев](https://docs.github.com/en/actions/concepts/billing-and-usage). Используются только стандартные ubuntu runners, без larger runners, платных сервисов, карт и новых artifact-хранилищ. При изменении видимости репозитория или runner labels нужно заново проверить условия.

Cloudflare/Netlify/AI остаются на подтверждённых бесплатных тарифах и имеют собственные лимиты; успешный CI/CD не увеличивает эти квоты.

## Обновление и восстановление

1. Изменение → commit/push → успешный CI → CD → health с ожидаемым SHA.
2. Не добавляй рабочую .env в GitHub; локальная публикация с изменением секретов остаётся отдельной операцией.
3. При истечении deploy token обнови отдельный environment secret после получения разрешённого ключа. Ошибка CD не меняет работающую старую версию.
4. Для rollback верни нужный код новым commit в main; после CI он пройдёт тот же путь. Базы/настройки при этом не откатываются. Несовместимые миграции требуют отдельного плана восстановления.
5. GitHub не является резервной копией SQLite Durable Objects или Beads/Dolt.
