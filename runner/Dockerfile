# 构建：docker build -t tokendash-runner ./runner
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/runner .

FROM scratch
# 静态二进制 + CA 证书（runner 需要发 HTTPS 请求）
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /out/runner /runner
ENTRYPOINT ["/runner"]
