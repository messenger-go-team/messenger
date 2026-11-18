# Автодеплой staging с отдельными правами (#37)

Actions проверяет успешность Go CI и Frontend CI для точного SHA ветки
`main`. Завершение любого из двух CI запускает эту проверку. Очередь
GitHub сгруппирована по SHA: ожидающий новый SHA не заменяется
устаревшим. На VPS один файловый lock сериализует выкаты; после него
приёмник снова проверяет актуальность SHA и результаты обоих CI.
Ещё раз они проверяются непосредственно после сборки.

Запись в GitHub Deployments создаётся только после подтверждения
нового SHA с VPS. Выключенный, устаревший или уже активный релиз
отражается в логе Actions, без новой записи об успешном выкате.

## Граница полномочий на общем VPS

- Отдельный пользователь Linux `messenger-stage`, без `sudo`, группы
  `docker` и доступа к системному `/var/run/docker.sock`. У него свой
  rootless Docker на `/run/user/<UID>/docker.sock`.
- Отдельные домашний каталог, Compose project, Docker-сеть, том
  PostgreSQL и секреты staging. В пользовательские контейнеры
  не монтируются системный сокет Docker, системные файлы, каталоги
  чужих сервисов, TLS-ключи и данные production.
- Администратор управляет внешним Nginx и TLS. Внешний Nginx
  проксирует только домен staging на `127.0.0.1:18080`. На этом порту
  работает внутренний Nginx rootless-контейнера. Он использует
  публичные snippets и пересылает запросы в Auth, History и Chat.
- Производственный Nginx, системный Docker и production Compose
  остаются за пределами доступа `messenger-stage`. Rootless
  делит ядро и ресурсы VPS; отдельная VM создаёт более жёсткую границу.

## Подготовка новой копии staging

1. Администратор создаёт `messenger-stage`, настраивает rootless Docker
   для этого пользователя и включает его пользовательский сервис.
   Следуйте [инструкции Docker Rootless](https://docs.docker.com/engine/security/rootless/).
   На общем VPS системный Docker нужен остальным сервисам; при
   установке отдельного rootless daemon оставьте системный запущенным.
   Проверьте `docker info` на пользовательском сокете. Системный сокет
   должен быть недоступен тому же пользователю.
2. В `~/messenger36-stage` скопируйте
   [compose.yaml](staging-rootless/compose.yaml), внутренний
   [nginx.conf](staging-rootless/nginx.conf) и необходимые snippets из
   `deploy/nginx/snippets`. До старта ingress создайте
   `nginx/snippets/release-marker.conf` со строкой
   `return 200 "baseline";`. Запишите staging-only параметры Compose
   в файл `.env` с правами 0600. `STAGING_BASE_SHA` ссылается на
   подготовленные образы baseline из проверенного main, а остальные
   переменные описаны в Compose. Пароли DSN кодируются для URL.
3. Запустите PostgreSQL нового проекта. Восстановите staging-дамп в
   его отдельный том. Владельцев объектов и рабочие роли Auth/History
   подготовьте в новой БД до восстановления ACL. Прежний VPS-стенд
   продолжает обслуживать домен на время подготовки. Соберите или
   загрузите три образа baseline и запустите Auth/Chat/History/ingress.
   Проверьте готовность и доступ по локальному HTTP
   `127.0.0.1:18080`. Создайте отдельный аккаунт WSS-пробы в этой БД
   и сохраните его `{"username":"…","password":"…"}` в
   `~/messenger36-stage/wss-probe.json` с правами 0600.
4. В согласованное окно перенесите последние staging-данные, если они
   менялись, и переключите внешний Nginx на
   [внутренний loopback-порт](staging-rootless/outer-location.conf.example).
   Если внешний Nginx работает в контейнере, для доступа к
   loopback хоста нужна соответствующая настройка сети, например host
   networking. Сохраните домен, ACME и сертификаты под управлением
   администратора. Проверьте `nginx -t`, HTTPS и публичный WSS.
   Прежнюю копию сохраните до завершения проверки.
5. От имени `messenger-stage` проверьте, что он управляет своим Docker,
   не член групп `sudo`/ `docker`, не может открыть системный сокет и
   менять файлы внешнего Nginx и TLS. Эти проверки проводятся на
   целевом VPS до выдачи ключа Actions.

## GitHub и SSH после подтверждения границы

- Repository variable `STAGING_CD_ENABLED=false`. Эта переменная
  читается до входа в Environment. Старый флаг
  `STAGING_DEPLOY_ENABLED` больше не используется.
- Environment `staging` разрешает только `main`. Переменные:
  `STAGING_SSH_HOST` и `STAGING_KNOWN_HOSTS` с закреплённым ключом
  хоста. Secret: отдельный закрытый ключ `STAGING_SSH_KEY`.
- Установите SSH-приёмник как root-owned
  `/usr/local/sbin/messenger-staging-receive` с режимом 0755.
  Разрешённый открытый ключ добавляется к `messenger-stage`, не к root:

  ```text
  restrict,command="/usr/local/sbin/messenger-staging-receive" ssh-ed25519 <public-key> messenger-staging-actions
  ```

  Проверьте `probe` со строгой проверкой host key, отказ для
  произвольной команды и отказ сменить релиз на непроверенный SHA.
  Публичные API GitHub читаются по HTTPS. Если состояние SHA или CI
  нельзя подтвердить, приёмник прекращает попытку.
- После merge и проверок выставьте `STAGING_CD_ENABLED=true`. Первый
  запуск можно выбрать вручную в Actions для текущего main. Запишите
  SHA, ссылку на Actions, результаты WSS и smoke.
  Отключение переменной останавливает новые вызовы из Actions;
  удаление строки открытого ключа на VPS отзывает доступ.
