import http from '@/axios/index.js';

export function settingSet(setting) {
    return http.put('/setting/set', setting)
}

export function settingQuery() {
    return http.get('/setting/query')
}

export function websiteConfig() {
    return http.get('/setting/websiteConfig')
}

export function setBackground(background) {
    return http.put('/setting/setBackground',{background})
}

export function deleteBackground() {
    return http.delete('/setting/deleteBackground')
}

export function setBlackList(params) {
    return http.put('/setting/setBlacklist', params)
}

export function settingMcp() {
    return http.get('/setting/mcp')
}

export function settingMcpToken() {
    return http.post('/setting/mcp/token')
}

export function settingMcpRevoke() {
    return http.delete('/setting/mcp/token')
}

export function settingMcpDevices() {
    return http.get('/setting/mcp/devices')
}

export function settingMcpDeviceRevoke(deviceId) {
    return http.delete('/setting/mcp/devices', {params: {deviceId}})
}