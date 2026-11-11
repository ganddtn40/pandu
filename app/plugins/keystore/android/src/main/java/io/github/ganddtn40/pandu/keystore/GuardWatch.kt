package io.github.ganddtn40.pandu.keystore

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * The compliant background option.
 *
 * A permanent foreground service is the wrong tool here: Android 12+ blocks
 * starting one from the background, Android 15 caps `dataSync` at six hours in
 * any twenty-four, and Play policy treats a `specialUse` service for approval
 * polling as review bait. WorkManager runs a bounded check at most every
 * fifteen minutes, survives reboot, needs no notification of its own, and does
 * not ask for an exemption. The app still uses its WebSocket for live updates
 * while it is open.
 */
object GuardWatch {
    private const val UNIQUE = "pandu-guard-watch"
    private const val UNIQUE_NOW = "pandu-guard-watch-now"

    fun schedule(context: Context) {
        val request = PeriodicWorkRequestBuilder<GuardWatchWorker>(15, TimeUnit.MINUTES)
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build(),
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            UNIQUE,
            ExistingPeriodicWorkPolicy.UPDATE,
            request,
        )
    }

    fun runNow(context: Context) {
        val request = OneTimeWorkRequestBuilder<GuardWatchWorker>()
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build(),
            )
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            UNIQUE_NOW,
            ExistingWorkPolicy.REPLACE,
            request,
        )
    }

    fun cancel(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(UNIQUE)
        WorkManager.getInstance(context).cancelUniqueWork(UNIQUE_NOW)
    }
}
