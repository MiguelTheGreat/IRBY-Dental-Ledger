package com.irbyclinic.dentalledger;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.view.View;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebView;

public class ClinicWebChromeClient extends WebChromeClient {

    private final MainActivity mActivity;

    public ClinicWebChromeClient(MainActivity activity) {
        this.mActivity = activity;
    }

    @Override
    public void onProgressChanged(WebView view, int newProgress) {
        if (mActivity.mProgressBar != null) {
            mActivity.mProgressBar.setProgress(newProgress);
            if (newProgress >= 100) {
                mActivity.mProgressBar.setVisibility(View.GONE);
            }
        }
    }

    @Override
    public void onPermissionRequest(final PermissionRequest request) {
        mActivity.mCurrentPermissionRequest = request;
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    if (mActivity.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                    } else {
                        mActivity.requestPermissions(new String[]{Manifest.permission.CAMERA}, 101);
                    }
                } else {
                    request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                }
                return;
            }
        }
        request.grant(request.getResources());
    }
}
