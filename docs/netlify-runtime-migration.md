# Подготовка modern Netlify Functions — bob-wrh.30.1

16 ноября 2026. **Код подготовлен, production не обновлялся.** Пользователь выбрал подготовку без создания токена и публикации. Изменения оформляются отдельной веткой `codex/netlify-modern-runtime` и draft PR; main/CD и работающий мост остаются прежними. Родительская bob-wrh.30 требует отдельного разрешённого развёртывания и проверки платформы.

## Изменение

Netlify [прекратит принимать новые Lambda-compatibility deploy с 1 июля 2027](https://docs.netlify.com/build/functions/lambda-compatibility/). Выбран нативный [Request/Response API](https://docs.netlify.com/build/functions/api/), без дополнительного `aws-lambda-compat`: само ядро моста уже принимает Request. Entry point экспортирует default handler и `config.path='/api/gigachat'`, вместо named `handler` и rewrite на legacy endpoint.

`createNetlifyHandler` читает входной поток с пределом 110000 байт и отменяет слишком большой поток. В ядро передаются исходные байты без JSON parse/stringify/base64-преобразования. Метод, URL, query и заголовки сохраняются. Ответ ядра — обычный Response; ошибки границы возвращают обезличенный JSON. Не меняются HMAC, одноразовый durable claim, deadline, схемы функций, модель/cap, app-only CA и ограничения доступа.

## Сборка без внешних запросов к модели

Из корня репозитория, с ранее проверенным публичным CA:

```powershell
node scripts/build-gigachat-relay.mjs --platform netlify --ca work/gigachat-root.pem
```

Новый каталог `work/gigachat-netlify-modern-release` содержит 12 разрешённых файлов плюс release manifest. Старый `work/gigachat-netlify-release` сохраняется для сопоставления/отката. Там нет `.env`, данных бота и приватных ключей. Публичный CA проверяется по прежнему fingerprint.

Официальным Netlify CLI **27.19.0** из новой папки выполняется локальная упаковка:

```text
netlify functions:build --src functions --functions ../gigachat-netlify-modern-functions
```

Затем из корня:

```powershell
node scripts/check-netlify-build.mjs work/gigachat-netlify-modern-release work/gigachat-netlify-modern-functions/manifest.json
```

Фактически полученный manifest: runtimeAPIVersion=2, bootstrapVersion=2.24.0, Node 24, native route `/api/gigachat`. Manifest также указывает invocationMode=stream — это способ вызова modern runtime, а не включение потоковых генераций GigaChat: в запросе к модели по-прежнему `stream:false`. Gate отклоняет runtime API1, неверную версию Node/маршрут/лишние функции и изменённые файлы release. CLI установлен только в игнорируемом каталоге инструментов; проект не получает новую runtime npm-зависимость.

## Что проверено и чего пока нет

Тесты покрывают Unicode/emoji/escaped JSON/исходные пробелы и подпись, предельный размер и отмену бесконечного потока, метод/query, статусы и скрытие исключений. Подписанный вымышленный запрос с недопустимой моделью доходит до проверки тела и получает BRIDGE_REQUEST; изменённый байт даёт BRIDGE_AUTH; claim/OAuth/генерация не вызываются. Существующие тесты одноразового резерва и квот сохранены. Полный Node/workerd CI используется с подменёнными внешними API.

Это не доказывает, что прежняя ошибка Netlify 502/`NUL after top-level value` устранена на платформе: рабочий endpoint пока старый. Не использовать отдельный Node-тест как свидетельство успешной публикации.

## Следующий этап после отдельного поручения

В кабинете подтверждены Free/$0/без карты, 255 оставшихся кредитов из 300 на момент подготовки. Production deploy расходует бесплатные кредиты. Перед будущей публикацией проверить условия/остаток снова. Новый PAT не создавался: подготовленная форма отменена после ответа пользователя.

После авторизованного временного доступа: сохранить текущий published deploy ID для отката; загрузить только проверенный modern release в существующий проект с сохранением двух runtime secrets и приватности previews. Старые локальные helper-скрипты указывают на legacy-каталог: **не запускать их для modern-релиза без изменения пути и проверки manifest**.

Для начального smoke достаточно GET health (200), неподписанного/устаревшего POST (403), слишком большого тела (413), подписанного синтетического запроса с недопустимой моделью (400/BRIDGE_REQUEST) и корректной схемы с несуществующим резервом (409/BRIDGE_CLAIM). Последние проверки подтверждают подпись/маршрут до генерации и не расходуют GigaChat-токены. При 502 откатить published deploy на сохранённую версию. Полный успешный вызов модели — только с новым ограниченным разрешением; прежние probe-бюджеты исчерпаны.
