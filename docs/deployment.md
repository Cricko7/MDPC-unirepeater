# Развёртывание Датарк на Linux

Серверный образ содержит главную, мониторинг, калькулятор, исходные данные для расчёта и админ-панель. GitHub Pages продолжает отдавать статическую версию из репозитория со встроенными настройками.

## Первый запуск

Нужны Docker Engine, Compose v2, Bash и `flock`. В примерах проект размещён в `/opt/datark`. Конфигурация публикует порт контейнера только на локальном интерфейсе сервера. Для доступа извне настройте существующий reverse proxy с HTTPS на `127.0.0.1:8080`. Прокси должен сохранять заголовок Authorization и передавать GET, HEAD и PUT. HTTP перенаправляйте на HTTPS.

1. Разместите проверенную копию репозитория в `/opt/datark`.
2. Создайте файл пароля вне репозитория. Пример для интерактивного Bash под пользователем, запускающим Compose.

   ```bash
   umask 077
   mkdir -p "$HOME/.config/datark"
   read -rsp 'Пароль администратора: ' datark_password
   printf '\n'
   printf '%s\n' "$datark_password" > "$HOME/.config/datark/admin-password"
   unset datark_password
   chmod 0444 "$HOME/.config/datark/admin-password"
   ```

   Каталог имеет режим 0700 и защищает файл на хосте. Режим файла 0444 позволяет читать его внутри контейнера процессу с UID 10001 через read-only mount Compose. Используйте длинный уникальный пароль. Если тот же пароль нужен новому контейнеру после ротации, обновите файл и пересоздайте сервис.

3. В `/opt/datark/.env` укажите абсолютный путь к паролю и при необходимости измените пользователя или локальный порт.

   ```dotenv
   DATARK_ADMIN_PASSWORD_FILE=/home/deploy/.config/datark/admin-password
   DATARK_ADMIN_USER=admin
   DATARK_PORT=8080
   ```

4. Для локальной сборки и запуска выполните команды из корня репозитория.

   ```bash
   docker build --build-arg REVISION="$(git rev-parse HEAD)" -t datark:local .
   docker compose up -d --wait
   curl --fail http://127.0.0.1:8080/healthz
   ```

5. Откройте `/admin/` по HTTPS. На локальном сервере страницу можно проверить через SSH-туннель на порт 8080. В панели доступны стартовый сценарий мониторинга, параметры пяти LTE-несущих и диапазон с ARFCN для тестового GSM. Сохранённые браузерные настройки продолжают применяться. Калькулятор получает серверные значения при открытии страницы и использует их при сбросе настроек.

## CI/CD

Workflow **Server image** проверяет JavaScript, запускает расчёт радиолинии, собирает контейнер и проверяет публичные страницы, авторизацию, валидацию и сохранение настроек. На `main` тот же проверенный образ публикуется в GitHub Container Registry с тегом `sha-<полный SHA>`. Проверка запускается и для PR. [Документация GitHub Packages](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)

Для включения выкладки создайте GitHub Environment `production` и добавьте:

| Параметр | Где хранить |
| --- | --- |
| `DATARK_DEPLOY_ENABLED=true` | Переменная репозитория |
| `DATARK_DEPLOY_HOST`, `DATARK_DEPLOY_USER` | Переменные окружения `production` |
| `DATARK_DEPLOY_SSH_KEY` | Секрет окружения с выделенным SSH-ключом |
| `DATARK_DEPLOY_KNOWN_HOSTS` | Секрет окружения с записью проверенного ключа хоста |

Разместите Compose и скрипт выкладки в `/opt/datark`, сделайте скрипт исполняемым командой `chmod +x deploy/deploy.sh`. SSH-пользователь должен иметь доступ к Docker и право записи в каталог `deploy`. Если пакет GHCR приватный, войдите в реестр от имени этого пользователя с токеном для чтения пакета. Указанная конфигурация собирает Linux AMD64. Перед запуском на ARM64 добавьте сборку соответствующей платформы.

После настройки workflow выкладывает актуальный образ из `main` по SSH. Выкладку также можно запустить вручную из Actions с ветки `main`. Команда обновляет сервис, ждёт успешной проверки `/healthz` и возвращает предыдущий успешный образ при сбое. [Docker Compose в production](https://docs.docker.com/compose/how-tos/production/)

Для ручной выкладки или отката выполните на сервере:

```bash
/opt/datark/deploy/deploy.sh ghcr.io/cricko7/mdpc-unirepeater:sha-<полный-SHA>
```

## Данные и диагностика

Настройки лежат в именованном томе `settings` в файле `/data/settings.json`. Обновление контейнера сохраняет том. Скопировать настройки для резервной копии можно командой `docker compose cp web:/data/settings.json ./settings-backup.json` после первого сохранения в панели. Диагностика доступна через `docker compose logs --tail=100 web`. `/healthz` возвращает состояние сервиса и ревизию образа.
