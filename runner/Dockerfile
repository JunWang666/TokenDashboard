# 构建：docker build -t tokendash-runner ./runner
# 交叉编译：CI 里多架构构建时 Go 交叉编译，避免 QEMU 模拟
FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/runner .

FROM scratch
# 静态二进制 + CA 证书（runner 需要发 HTTPS 请求）
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /out/runner /runner
ENTRYPOINT ["/runner"]
