package expo.modules.phonecontactpicker

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.provider.ContactsContract
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val RC_PICK_PHONE = 4127

/**
 * Launches the system contacts app with `ACTION_PICK` on the phone-number
 * data kind and resolves the one number the user taps. The picker runs in
 * the contacts app's process and grants this app a one-shot read on the
 * returned URI only, so no `READ_CONTACTS` permission is declared or
 * requested. See modules/phone-contact-picker/index.ts.
 */
class PhoneContactPickerModule : Module() {
  private var pending: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("PhoneContactPicker")

    AsyncFunction("pickPhoneAsync") { promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject("E_NO_ACTIVITY", "No foreground activity", null)
        return@AsyncFunction
      }
      if (pending != null) {
        promise.reject("E_PICK_IN_PROGRESS", "A pick is already in progress", null)
        return@AsyncFunction
      }
      val intent =
        Intent(Intent.ACTION_PICK, ContactsContract.CommonDataKinds.Phone.CONTENT_URI)
      pending = promise
      try {
        activity.startActivityForResult(intent, RC_PICK_PHONE)
      } catch (e: ActivityNotFoundException) {
        pending = null
        promise.reject("E_NO_CONTACTS_APP", "No contacts app available", e)
      }
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != RC_PICK_PHONE) return@OnActivityResult
      val promise = pending ?: return@OnActivityResult
      pending = null

      val uri = payload.data?.data
      if (payload.resultCode != Activity.RESULT_OK || uri == null) {
        promise.resolve(null)
        return@OnActivityResult
      }

      try {
        val resolver = appContext.reactContext?.contentResolver
        val projection = arrayOf(
          ContactsContract.CommonDataKinds.Phone.NUMBER,
          ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
        )
        resolver?.query(uri, projection, null, null, null)?.use { cursor ->
          if (cursor.moveToFirst()) {
            promise.resolve(
              mapOf(
                "number" to cursor.getString(0),
                "name" to cursor.getString(1),
              ),
            )
            return@OnActivityResult
          }
        }
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("E_READ_FAILED", "Could not read the picked contact", e)
      }
    }
  }
}
