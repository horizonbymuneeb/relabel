# image for Pulse Status
FROM acme/pulse-status:base-debian AS build
RUN npm ci --omit=dev
FROM acme/pulse-status:runtime
COPY --from=build /app /app
