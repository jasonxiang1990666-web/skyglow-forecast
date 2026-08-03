# model-image-renderer

这个云托管服务将 **ECMWF IFS（EC）** 和 **NOAA GFS** 的总云量 GRIB 数据裁剪为上海周边的 PNG 云量图。它不向小程序直接开放；由 `modelImageSync` 云函数请求后上传到云存储，详情页再通过 `imageFileId` 展示。

## 运行方式

服务提供两个接口：

- `GET /health`：健康检查。
- `POST /render`：接收 `source`、`runAt`、`validAt`、上海坐标与地图范围，返回 `image/png`。

若设置了 `MODEL_RENDERER_TOKEN`，请求必须携带同一个 Bearer Token。

## 部署到 CloudBase 云托管

1. 在 CloudBase 控制台进入当前环境，打开 **云托管**，新建服务 `model-image-renderer`。
2. 选择从本地代码或 Git 仓库构建，构建目录选择 `services/model-image-renderer`，Dockerfile 使用本目录的 `Dockerfile`。
3. 服务端口填写 `8080`；实例规格建议至少 1 核 / 1 GB，因为 GRIB 解码和绘图需要内存。
4. 为该服务设置环境变量 `MODEL_RENDERER_TOKEN`，填写一个随机字符串。
5. 部署成功后复制服务的 HTTPS 访问地址，例如 `https://xxxx.service.tcloudbase.com`。
6. 在 `modelImageSync` 云函数的环境变量中填写：

   - `MODEL_IMAGE_RENDERER_URL`：上一步的服务地址（不要加 `/render`）。
   - `MODEL_IMAGE_RENDERER_TOKEN`：与云托管服务完全一致的随机字符串。

7. 将 `modelImageSync` 的超时设为 **60 秒**、内存设为 **512 MB**，部署后先以 `{ "dryRun": true }` 测试选中的 4 个时段，再以 `{}` 生成并回写图片。

> 首次拉取 ECMWF/GFS GRIB 文件可能耗时更长。若某一个模式或起报周期尚未提供数据，云函数会只记录该项失败，不影响另一模式或另一时段的图片。
