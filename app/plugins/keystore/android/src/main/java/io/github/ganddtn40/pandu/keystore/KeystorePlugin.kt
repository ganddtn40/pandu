package io.github.ganddtn40.pandu.keystore

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class SaveArgs {
    lateinit var token: String
}

@InvokeArg
class ConfigureArgs {
    lateinit var host: String
}

@InvokeArg
class ScheduleArgs {
    var enabled: Boolean = true
}

/**
 * The companion's native commands. The token is encrypted with a Keystore key;
 * the host origin is stored separately because it is not a secret and the
 * background worker needs it before the webview exists.
 */
@TauriPlugin
class KeystorePlugin(private val activity: Activity) : Plugin(activity) {
    private val store by lazy { SecureTokenStore(activity.applicationContext) }

    @Command
    fun load(invoke: Invoke) {
        val result = JSObject()
        result.put("token", store.load() ?: "")
        invoke.resolve(result)
    }

    @Command
    fun save(invoke: Invoke) {
        val args = invoke.parseArgs(SaveArgs::class.java)
        try {
            store.save(args.token)
            invoke.resolve()
        } catch (error: Exception) {
            invoke.reject(error.message ?: "The token could not be stored.")
        }
    }

    @Command
    fun host(invoke: Invoke) {
        val result = JSObject()
        result.put("host", store.host() ?: "")
        invoke.resolve(result)
    }

    @Command
    fun configure(invoke: Invoke) {
        val args = invoke.parseArgs(ConfigureArgs::class.java)
        try {
            val host = HostPolicy.normalize(activity.applicationContext, args.host)
            store.setHost(host)
            GuardNotifications.ensureChannels(activity.applicationContext)
            GuardWatch.schedule(activity.applicationContext)
            GuardWatch.runNow(activity.applicationContext)
            val result = JSObject()
            result.put("host", host)
            invoke.resolve(result)
        } catch (error: Exception) {
            invoke.reject(error.message ?: "That host address is not valid.")
        }
    }

    @Command
    fun schedule_watch(invoke: Invoke) {
        val args = invoke.parseArgs(ScheduleArgs::class.java)
        if (args.enabled) {
            GuardWatch.schedule(activity.applicationContext)
            GuardWatch.runNow(activity.applicationContext)
        } else {
            GuardWatch.cancel(activity.applicationContext)
        }
        invoke.resolve()
    }

    @Command
    fun notifications_init(invoke: Invoke) {
        GuardNotifications.ensureChannels(activity.applicationContext)
        invoke.resolve()
    }

    @Command
    fun clear(invoke: Invoke) {
        GuardWatch.cancel(activity.applicationContext)
        store.clear()
        invoke.resolve()
    }
}
