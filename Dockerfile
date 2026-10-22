# Sheet Metal Manager in a container. The website needs no npm packages; a database driver is
# added only for the database you choose, e.g.:
#   docker build -t smm .                              (SQLite, the default)
#   docker build --build-arg DB_DRIVERS="pg" -t smm .  (PostgreSQL; or mysql2, mssql, oracledb)
FROM node:22-bookworm-slim
ARG DB_DRIVERS=""
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 HOST=0.0.0.0
WORKDIR /app
COPY package.json ./
RUN if [ -n "$DB_DRIVERS" ]; then npm install --omit=dev --no-save --no-package-lock $DB_DRIVERS && npm cache clean --force; fi
COPY server ./server
COPY public ./public
COPY tools ./tools
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/server.js"]
