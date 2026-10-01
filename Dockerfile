FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src/ src/
COPY server/ server/
COPY scripts/build.mjs scripts/package-release.mjs scripts/
COPY vendor/ vendor/
RUN npm run build && npm run release

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=1000:1000 /app/dist/ dist/
COPY --from=build --chown=1000:1000 /app/server/runtime.mjs server/runtime.mjs
COPY --from=build --chown=1000:1000 /app/server/recruitment-worker-runtime.mjs server/recruitment-worker-runtime.mjs
COPY --from=build --chown=1000:1000 /app/server/recruitment-ops-runtime.mjs server/recruitment-ops-runtime.mjs
COPY --from=build --chown=1000:1000 /app/src/projects.json src/projects.json
COPY --from=build --chown=1000:1000 /app/src/assets/ src/assets/
COPY --from=build --chown=1000:1000 /app/vendor/RUNTIME-LICENSES.txt vendor/RUNTIME-LICENSES.txt
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/runtime.mjs"]
