import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common'
import type { Response } from 'express'
import { MAX_UPLOAD_MB } from './upload.config'

/**
 * 上传异常映射（局域网多人加固）
 *
 * Nest 默认把 multer 的 MulterError 统一转成 400，对「文件过大」语义不符。
 * 这里显式映射为 413（Payload Too Large）并给出上限值，便于用户自查。
 * 非 multer 异常一律按其原状态码透传，不改变既有错误语义。
 */
@Catch()
export class UploadExceptionFilter implements ExceptionFilter {
    catch(exception: any, host: ArgumentsHost): void {
        const res = host.switchToHttp().getResponse<Response>()
        const code = exception?.code

        if (code === 'LIMIT_FILE_SIZE') {
            res.status(HttpStatus.PAYLOAD_TOO_LARGE).json({
                statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
                message: `文件超过 ${MAX_UPLOAD_MB}MB 上限`,
            })
            return
        }

        if (code === 'LIMIT_FILE_COUNT' || code === 'LIMIT_UNEXPECTED_FILE') {
            res.status(HttpStatus.BAD_REQUEST).json({
                statusCode: HttpStatus.BAD_REQUEST,
                message: '上传字段或文件数量不合法',
            })
            return
        }

        // 其余异常透传原状态码（HttpException 自带 getStatus/getResponse）
        const status = typeof exception?.getStatus === 'function'
            ? exception.getStatus()
            : HttpStatus.INTERNAL_SERVER_ERROR
        const payload = typeof exception?.getResponse === 'function' ? exception.getResponse() : null
        res.status(status).json(
            payload && typeof payload === 'object'
                ? payload
                : { statusCode: status, message: exception?.message ?? '上传失败' },
        )
    }
}
