package org.joyfulchurch.joyfulprayer;

import android.os.Bundle;
import android.util.Log;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getBridge().getWebView().setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    for (String resource : request.getResources()) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                            request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                            return;
                        }
                    }
                    request.deny();
                });
            }
        });
    }
}