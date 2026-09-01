FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
# Auth tokens are cached here; mount a volume so you only sign in once.
ENV MCWV_PROFILES_DIR=/data/profiles
EXPOSE 8080
CMD ["node", "src/index.mjs"]
