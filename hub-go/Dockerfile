# syntax=docker/dockerfile:1
# Build:  docker build -t tokendash-hub .
# Run:    docker run -d -p 8787:8787 -v tokendash-data:/data \
#           -e CREDENTIALS_KEY=$(openssl rand -base64 32) tokendash-hub

FROM golang:1.24-alpine AS build
WORKDIR /src

# Allow overriding the module proxy for networks where proxy.golang.org is slow.
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY}

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/hub ./cmd/hub

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata \
    && adduser -D -u 10001 hub \
    && mkdir -p /data && chown -R hub:hub /data
COPY --from=build /out/hub /usr/local/bin/hub

ENV DB_PATH=/data/tokendash.db \
    LISTEN_ADDR=:8787 \
    COLLECT_INTERVAL=15m

VOLUME /data
EXPOSE 8787
USER hub

ENTRYPOINT ["/usr/local/bin/hub"]
