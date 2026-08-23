# Stage 1: build the Vite bundle.
# VITE_GEMINI_API_KEY must be present at BUILD time — Vite inlines it into the
# bundle. Railway passes service variables as build args when declared as ARG.
# NOTE: the key therefore ends up readable in the public JS bundle. Use a
# rotatable free-tier key. The main callTrainer repo is the fixed version.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_GEMINI_API_KEY
ENV VITE_GEMINI_API_KEY=$VITE_GEMINI_API_KEY
RUN npm run build

# Stage 2: serve dist/ with a zero-dependency node server.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=build /app/dist ./dist
COPY server.mjs ./
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
