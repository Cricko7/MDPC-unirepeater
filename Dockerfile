FROM python:3.13-slim
ARG REVISION=local
ENV PYTHONUNBUFFERED=1 DATARK_REVISION=$REVISION
LABEL org.opencontainers.image.revision=$REVISION
WORKDIR /app
RUN mkdir -p /data /run/datark && chown 10001:10001 /data
COPY index.html public/
COPY assets/ public/assets/
COPY monitor/ public/monitor/
COPY docs/mdpc-radio-layout.png docs/mdpc-link-budget.csv public/docs/
COPY tools/mdpc-scenario.json public/tools/
COPY server/app.py .
COPY server/admin/ admin/
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=4s --start-period=5s CMD ["python", "-c", "from urllib.request import urlopen; urlopen('http://127.0.0.1:8080/healthz', timeout=3).read()"]
CMD ["python", "app.py"]
