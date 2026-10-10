import { RPC_CHANNEL } from './constants.js'
export async function callRpc(connection, endpoint, payload) {
  try {
    if (!connection?.rpc?.call) return { ok: false, tone: 'bad', text: '宿主 RPC 通道不可用' }
    const reply = await connection.rpc.call(RPC_CHANNEL, endpoint, payload)
    if (reply?.ok === true) return { ok: true, tone: 'ok', text: '', value: reply.value }
    return { ok: false, tone: 'bad', text: String(reply?.error?.message ?? '未知错误') }
  } catch (error) {
    return { ok: false, tone: 'bad', text: error instanceof Error ? error.message : String(error) }
  }
}
