package io.github.ganddtn40.pandu.keystore

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * Notification channels, one per event type. Android 8+ ignores a notification
 * whose channel does not exist, so every path that posts one calls
 * [ensureChannels] first.
 */
object GuardNotifications {
    const val CHANNEL_CRITICAL = "pandu_guard_critical"
    const val CHANNEL_HIGH = "pandu_guard_high"
    const val CHANNEL_NORMAL = "pandu_guard_normal"
    const val CHANNEL_PAIRING = "pandu_pairing"

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val app = context.applicationInfo.loadLabel(context.packageManager).toString()
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_CRITICAL,
                "$app critical approvals",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "Critical actions waiting for your decision."
                lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_HIGH,
                "$app high-risk approvals",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "High-risk actions waiting for your decision."
                lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_NORMAL,
                "$app approvals",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = "Approval requests from your paired host."
                lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_PAIRING,
                "$app pairing",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = "Pairing and connectivity problems."
            },
        )
    }

    fun channelFor(severity: String?): String = when (severity?.lowercase()) {
        "critical" -> CHANNEL_CRITICAL
        "high" -> CHANNEL_HIGH
        else -> CHANNEL_NORMAL
    }

    fun notify(
        context: Context,
        id: Int,
        channel: String,
        title: String,
        body: String?,
    ) {
        ensureChannels(context)
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        val intent = (launch ?: Intent()).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_pandu)
            .setContentTitle(title)
            .setContentText(body ?: "")
            .setStyle(NotificationCompat.BigTextStyle().bigText(body ?: ""))
            .setPriority(
                if (channel == CHANNEL_CRITICAL || channel == CHANNEL_HIGH) {
                    NotificationCompat.PRIORITY_HIGH
                } else {
                    NotificationCompat.PRIORITY_DEFAULT
                },
            )
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        context.getSystemService(NotificationManager::class.java)
            ?.notify(id, notification)
    }
}
