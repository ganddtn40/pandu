package io.github.ganddtn40.pandu.keystore

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Fetch pending approvals and post one notification per new event.
 *
 * The request is a plain HTTPS GET with the paired device's bearer token. The
 * token is decrypted from the Keystore only for the duration of the call. No
 * flight content is downloaded: the worker asks for the pending guard list and
 * nothing else.
 */
class GuardWatchWorker(context: Context, params: WorkerParameters) :
    Worker(context, params) {

    override fun doWork(): Result {
        val store = SecureTokenStore(applicationContext)
        val host = store.host() ?: return Result.success()
        val token = store.load() ?: return Result.success()

        val body = try {
            fetch(host, token)
        } catch (_: Unauthorized) {
            onUnauthorized()
            return Result.success()
        } catch (_: Exception) {
            // Offline, DNS, or a sleeping host: try again on the next window.
            return Result.retry()
        }

        val prefs = applicationContext.getSharedPreferences(WATCH_PREFS, Context.MODE_PRIVATE)
        val notified = (prefs.getStringSet(KEY_NOTIFIED, emptySet()) ?: emptySet()).toMutableSet()
        val pendingIds = mutableSetOf<String>()
        var changed = false

        val events: JSONArray = try {
            JSONObject(body).optJSONArray("events") ?: JSONArray()
        } catch (_: Exception) {
            return Result.retry()
        }
        for (index in 0 until events.length()) {
            val event = events.optJSONObject(index) ?: continue
            val id = event.optString("id")
            if (id.isEmpty()) continue
            pendingIds.add(id)
            if (!notified.add(id)) continue
            val title = event.optString("title").ifBlank { "Approval needed" }
            val command = event.optString("command")
            val description = event.optString("description")
            val detail = when {
                command.isNotBlank() -> command
                description.isNotBlank() -> description
                else -> "Open the app to review the request."
            }
            GuardNotifications.notify(
                applicationContext,
                id.hashCode(),
                GuardNotifications.channelFor(event.optString("severity")),
                title,
                detail,
            )
            changed = true
        }

        // Keep the set bounded. Events that are no longer pending stay marked so
        // a transient list change cannot re-notify the same request.
        if (notified.size > MAX_REMEMBERED) {
            notified.clear()
            notified.addAll(pendingIds)
            changed = true
        }
        if (changed) {
            prefs.edit().putStringSet(KEY_NOTIFIED, notified).apply()
        }
        prefs.edit().putBoolean(KEY_EXPIRED_NOTIFIED, false).apply()
        return Result.success()
    }

    private fun onUnauthorized() {
        val prefs = applicationContext.getSharedPreferences(WATCH_PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(KEY_EXPIRED_NOTIFIED, false)) {
            val app = applicationContext.applicationInfo
                .loadLabel(applicationContext.packageManager)
                .toString()
            GuardNotifications.notify(
                applicationContext,
                PAIRING_NOTIFICATION_ID,
                GuardNotifications.CHANNEL_PAIRING,
                "$app needs to pair again",
                "The host revoked this device or the token expired. Open the app and scan a new pairing code.",
            )
            prefs.edit().putBoolean(KEY_EXPIRED_NOTIFIED, true).apply()
        }
        GuardWatch.cancel(applicationContext)
    }

    private fun fetch(host: String, token: String): String {
        val url = URL("$host/api/remote/guards/events?limit=20&status=pending")
        if (
            url.protocol != "https" &&
            !(url.protocol == "http" && HostPolicy.allowsCleartext(applicationContext, url.host))
        ) {
            throw IOException("HTTPS is required")
        }
        val connection = url.openConnection() as HttpURLConnection
        connection.requestMethod = "GET"
        connection.connectTimeout = 10_000
        connection.readTimeout = 10_000
        connection.setRequestProperty("Accept", "application/json")
        connection.setRequestProperty("Authorization", "Bearer $token")
        try {
            val code = connection.responseCode
            if (code == 401 || code == 403) throw Unauthorized()
            if (code !in 200..299) throw IOException("The host returned $code")
            return connection.inputStream.bufferedReader().use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    private class Unauthorized : IOException()

    companion object {
        private const val WATCH_PREFS = "pandu.guard.watch"
        private const val KEY_NOTIFIED = "notified"
        private const val KEY_EXPIRED_NOTIFIED = "expiredNotified"
        private const val MAX_REMEMBERED = 500
        private const val PAIRING_NOTIFICATION_ID = 0x50414E44
    }
}
