package com.irbyclinic.dentalledger;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.DialogInterface;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.Toast;

public class MainActivity extends Activity implements DialogInterface.OnClickListener {

    private static final String PREFS_NAME = "IRBYPrefs";
    private static final String KEY_SERVER_URL = "ServerUrl";
    private static final int REQ_CAMERA_PERMISSION = 101;

    private static final int DIALOG_PROMPT = 1;
    private static final int DIALOG_ERROR = 2;

    private int mActiveDialogType = 0;
    private EditText mInputEditText;

    WebView mWebView;
    ProgressBar mProgressBar;
    SharedPreferences mPrefs;
    PermissionRequest mCurrentPermissionRequest;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        mPrefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);

        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);

        mProgressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        mProgressBar.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 10));
        mProgressBar.setVisibility(View.GONE);
        layout.addView(mProgressBar);

        mWebView = new WebView(this);
        mWebView.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.MATCH_PARENT));
        layout.addView(mWebView);

        setContentView(layout);

        setupWebView();
        checkPermissions();

        String serverUrl = mPrefs.getString(KEY_SERVER_URL, "");
        if (serverUrl.isEmpty()) {
            promptServerUrl(false);
        } else {
            loadServerUrl(serverUrl);
        }
    }

    private void setupWebView() {
        WebSettings settings = mWebView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);

        mWebView.setWebViewClient(new ClinicWebViewClient(this));
        mWebView.setWebChromeClient(new ClinicWebChromeClient(this));
    }

    private void checkPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA_PERMISSION);
            }
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_CAMERA_PERMISSION && grantResults.length > 0 &&
                grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            if (mCurrentPermissionRequest != null) {
                mCurrentPermissionRequest.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                mCurrentPermissionRequest = null;
            }
        }
    }

    void loadServerUrl(String url) {
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "http://" + url;
        }
        mWebView.loadUrl(url);
    }

    void promptServerUrl(final boolean isChange) {
        mActiveDialogType = DIALOG_PROMPT;
        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle("Connect to Central Clinic Server");
        builder.setMessage("Enter the IP address or URL of the central clinic computer (e.g., http://192.168.1.12:3000):");

        mInputEditText = new EditText(this);
        String current = mPrefs.getString(KEY_SERVER_URL, "http://192.168.1.12:3000");
        mInputEditText.setText(current);
        mInputEditText.setSelection(mInputEditText.getText().length());
        builder.setView(mInputEditText);

        builder.setPositiveButton("Connect", this);

        if (isChange) {
            builder.setNegativeButton("Cancel", this);
        } else {
            builder.setCancelable(false);
        }

        builder.show();
    }

    void showErrorDialog(final String failedUrl) {
        mActiveDialogType = DIALOG_ERROR;
        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle("Clinic Server Unreachable");
        builder.setMessage("Could not connect to:\n" + failedUrl + "\n\nEnsure this tablet is connected to clinic Wi-Fi and the central server PC is running.");
        builder.setPositiveButton("Retry", this);
        builder.setNeutralButton("Change Server IP", this);
        builder.show();
    }

    @Override
    public void onClick(DialogInterface dialog, int which) {
        if (mActiveDialogType == DIALOG_PROMPT) {
            if (which == DialogInterface.BUTTON_POSITIVE && mInputEditText != null) {
                String url = mInputEditText.getText().toString().trim();
                if (!url.isEmpty()) {
                    mPrefs.edit().putString(KEY_SERVER_URL, url).apply();
                    loadServerUrl(url);
                }
            }
        } else if (mActiveDialogType == DIALOG_ERROR) {
            if (which == DialogInterface.BUTTON_POSITIVE) {
                mWebView.reload();
            } else if (which == DialogInterface.BUTTON_NEUTRAL) {
                promptServerUrl(true);
            }
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && mWebView.canGoBack()) {
            mWebView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
