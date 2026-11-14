# syntax=docker/dockerfile:1
FROM python:3.13-slim AS swagger
ADD --checksum=sha256:8e7286de0230e431fc8a5a75490d28117af3d0c306413b6f9e17f7bb55045fb6 https://registry.npmjs.org/swagger-ui-dist/-/swagger-ui-dist-5.34.1.tgz /tmp/swagger.tgz
RUN mkdir /swagger && tar -xzf /tmp/swagger.tgz --strip-components=1 -C /swagger \
    package/swagger-ui.css package/swagger-ui-bundle.js package/swagger-ui-bundle.js.LICENSE.txt \
    package/LICENSE package/NOTICE

FROM python:3.13-slim
ARG REVISION=local
ENV PYTHONUNBUFFERED=1 DATARK_REVISION=$REVISION
LABEL org.opencontainers.image.revision=$REVISION
WORKDIR /app
RUN mkdir -p /data /run/datark && chown 10001:10001 /data
COPY index.html public/
COPY assets/ public/assets/
COPY monitor/ public/monitor/
COPY docs/mdpc-radio-layout.png docs/mdpc-link-budget.csv docs/datark-expert-report.pdf public/docs/
COPY tools/mdpc-scenario.json public/tools/
COPY server/app.py .
COPY server/admin/ admin/
COPY --from=swagger /swagger/ admin/api/vendor/
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=4s --start-period=5s CMD ["python", "-c", "from urllib.request import urlopen; urlopen('http://127.0.0.1:8080/healthz', timeout=3).read()"]
CMD ["python", "app.py"]
