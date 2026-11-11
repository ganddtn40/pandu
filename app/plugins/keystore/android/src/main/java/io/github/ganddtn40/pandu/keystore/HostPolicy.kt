package io.github.ganddtn40.pandu.keystore

import android.content.Context
import android.content.pm.ApplicationInfo
import android.net.Uri

/**
 * Host validation shared by the webview command and the background worker.
 *
 * Release builds accept HTTPS only. Debug builds also accept cleartext to the
 * emulator loopback hosts that the debug network security config allows, so a
 * developer can pair with a local daemon without weakening the release APK.
 */
object HostPolicy {
    private const val MAX_HOST = 512

    fun normalize(context: Context, raw: String): String {
        val value = raw.trim()
        require(value.isNotEmpty()) { "Enter the host address." }
        require(value.length <= MAX_HOST) { "The host address is too long." }
        val uri = Uri.parse(value)
        val scheme = uri.scheme?.lowercase()
        val host = uri.host
        require(!host.isNullOrBlank()) { "The host address is not valid." }
        require(uri.userInfo == null) { "The host must not contain credentials." }
        require(uri.path.isNullOrEmpty() || uri.path == "/") {
            "Use the host origin, without a path."
        }
        require(uri.query == null && uri.fragment == null) {
            "The host must not contain a query or fragment."
        }
        require(
            scheme == "https" ||
                (scheme == "http" && isLoopback(host) && isDebuggable(context)),
        ) {
            if (isDebuggable(context) && isLoopback(host)) {
                "The host must use HTTPS."
            } else {
                "The host must use HTTPS. Plain HTTP is allowed only for the emulator in debug builds."
            }
        }
        val authority = uri.encodedAuthority
        require(!authority.isNullOrBlank()) { "The host address is not valid." }
        return "$scheme://$authority"
    }

    fun isLoopback(host: String): Boolean =
        host == "127.0.0.1" ||
            host.equals("localhost", ignoreCase = true) ||
            host == "::1" ||
            host == "[::1]" ||
            // The Android emulator reaches the development machine here.
            host == "10.0.2.2"

    fun allowsCleartext(context: Context, host: String?): Boolean =
        !host.isNullOrBlank() && isLoopback(host) && isDebuggable(context)

    private fun isDebuggable(context: Context): Boolean =
        (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
}
