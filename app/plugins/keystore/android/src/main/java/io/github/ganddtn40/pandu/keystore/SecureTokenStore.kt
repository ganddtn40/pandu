package io.github.ganddtn40.pandu.keystore

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The device token, encrypted with an AES-256-GCM key that lives in the
 * Android Keystore and never leaves it. Only the ciphertext and IV are written
 * to private SharedPreferences; WebView storage never sees the token.
 *
 * The key is not user-authentication bound: the companion can refresh its
 * dashboard without a prompt. High-risk approvals get a separate
 * BiometricPrompt/device-credential gate before the request is sent.
 */
class SecureTokenStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(PROVIDER).apply { load(null) }
        val existing = store.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry
        if (existing != null) return existing.secretKey

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        generator.init(
            KeyGenParameterSpec.Builder(
                ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    @Throws(Exception::class)
    fun save(token: String) {
        require(token.isNotEmpty()) { "The device token is empty." }
        require(token.length <= MAX_TOKEN) { "The device token is too long." }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val ciphertext = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        prefs.edit()
            .putString(KEY_TOKEN, Base64.encodeToString(ciphertext, Base64.NO_WRAP))
            .putString(KEY_IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .apply()
    }

    fun load(): String? {
        val ciphertext = prefs.getString(KEY_TOKEN, null) ?: return null
        val iv = prefs.getString(KEY_IV, null) ?: return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                key(),
                GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)),
            )
            String(cipher.doFinal(Base64.decode(ciphertext, Base64.NO_WRAP)), Charsets.UTF_8)
        } catch (_: Exception) {
            // A key that was invalidated (factory reset, lock screen change) is
            // useless. Drop the ciphertext so the user pairs again.
            clear()
            null
        }
    }

    fun clear() {
        prefs.edit().remove(KEY_TOKEN).remove(KEY_IV).remove(KEY_HOST).apply()
        try {
            val store = KeyStore.getInstance(PROVIDER).apply { load(null) }
            if (store.containsAlias(ALIAS)) store.deleteEntry(ALIAS)
        } catch (_: Exception) {
            // The key is already gone.
        }
    }

    fun host(): String? = prefs.getString(KEY_HOST, null)

    fun setHost(host: String) {
        prefs.edit().putString(KEY_HOST, host).apply()
    }

    companion object {
        private const val PREFS = "pandu.companion.secure"
        private const val PROVIDER = "AndroidKeyStore"
        private const val ALIAS = "pandu.remote.token.v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val KEY_TOKEN = "token"
        private const val KEY_IV = "iv"
        private const val KEY_HOST = "host"
        private const val MAX_TOKEN = 4096
    }
}
