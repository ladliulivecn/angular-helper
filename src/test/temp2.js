/**
 * Created by lad on 2016/9/5.
 */

var TYPE_SCHOOL = 1; //幼儿园
var TYPE_COMPANY = 2; //厂商
var TYPE_BUYER = 3; //买家
var TYPE_HIDECOST = 4; //隐藏票种信息
var app = angular.module('actInfoApp', []);
var login_key = null;
var timeout = null;
var signUrl = null;
const BJLOCALOFFSET = -28800000;//单位：毫秒，北京时间跟utc时间的时间差
function GetLocalTime(Ds) {
    var utcTime = dayjs(Ds).valueOf();
    var offset = new Date().getTimezoneOffset() * 60000;
    utcTime += BJLOCALOFFSET - offset;
    return dayjs(utcTime);
}
function GetUrlPrefix() {
    var prefix = "https://manage-test.yoursclass.com"
    if (window.location.host.substr(0, 19) === 'manage.kaisaile.org') {
        prefix = "https://manage.yoursclass.com";
    }
    return prefix + "/yike_mgr";
}
function GetPcAuthUrl() {
    login_key = GenerateUUID();
    return GetUrlPrefix() + "/views/wxlogin/h5login/wx84b1612e5c750eab/" + login_key;
}
function ExistCheckWxAuthProc() {
    if (timeout) {
        clearTimeout(timeout);
        timeout = null;
    }
    login_key = null;
}
function HideWxQrcode() {
    $(".cover2").hide();
    $(".FX_weixin2").hide();
    ExistCheckWxAuthProc();
}
function SendOpenid(openid) {
    $.ajax({
        type: 'POST',
        dataType: 'json',
        url: "/index.php/RestCore/UpdateWxUserByPC",
        data: JSON.stringify({ wxOpenId: openid }),
        success: function (res) {
            if (res && res.resp && res.resp.err == 0) {
                HideWxQrcode();
                window.location.href = signUrl;
            }
        },
        error(e) {
            alert(e);
        }
    });
}
function CheckWxAuthProc() {
    if (!timeout && login_key) {
        timeout = setTimeout(function () {
            timeout = null;
            $.ajax({
                type: 'POST',
                url: GetUrlPrefix() + "/v1/wx/pcauth_wx_login",
                data: { login_key },
                success: function (res) {
                    if (res && res.code == 0 && res.data && res.data.login_openid) {
                        SendOpenid(res.data.login_openid);
                    } else {
                        CheckWxAuthProc();
                    }
                },
                error(e) {
                    CheckWxAuthProc();
                }
            });
        }, 2000);
    }
}
function ShowQrcode() {
    var url = GetPcAuthUrl();
    $('#code2').html('');
    $('#code2').qrcode(url);
    $(".cover2").show();
    $(".FX_weixin2").show();
    $("#code2 canvas").css("width", 190);
    $("#code2 canvas").css("height", 190);
    CheckWxAuthProc();
}
$(".close2").click(function () {
    HideWxQrcode();
})

app.controller('actInfoCtrl', function ($rootScope, $scope, $http, $timeout, $window) {
    var nexturl = getUrlParam('nexturl');
    var jwttoken = getUrlParam('jwttoken');
    var certlevel = 0;//当前的棋力等级，根据证书id获取
    var currgroupindex = -1;//保存已报名的分组的序号
    var hassigngroupid = null, choosegroupid = null;
    $scope.token = getUrlParam('token');

    $scope.showback = false;
    if (window.history.length > 1) {
        $scope.showback = true;
    }
    var openId = $('#openid').val();
    if (!openId) {
        openId = '';
    }
    var shareId = getUrlParam('shareID');
    var loadingToast = $('#loadingToast');
    var fromopenid = getUrlParam('from'); //小程序openid
    var sharemd5 = getUrlParam('sharemd5');
    var sharejgid = getUrlParam('sharejg');//
    var fieldid = getUrlParam('fieldid');//
    var specialid = getUrlParam('local_id');
    var signextinfo = getUrlParam('signextinfo');
    $scope.rootPath = '/index.php';
    /*var test = window.location.href;
    $http.post('https://wxapi.kaisaile.org/gen-qrimg', { 'path': `/pages/webview/webview?src=${test}` })
        .success(function(ret) {
            console.log(ret)
        })
*/
    var actId = getUrlParam('id');
    if (!actId) {
        alert('缺少活动ID!');
        return;
    }
    var signjgid = getUrlParam('jgid');
    var indexType = getUrlParam('st');
    if (indexType) {
        indexType = parseInt(indexType);
    } else {
        indexType = 0;
    }
    switch (indexType) {
        case TYPE_SCHOOL:
        case TYPE_COMPANY:
        case TYPE_BUYER:
            $scope.hideSchool = true;
            break;
        case TYPE_HIDECOST:
            $scope.hideCost = true;
            break;
    }
    $scope.signStyle = {
        'background': '#C7C8C9'
    };

    $scope.url = window.location.href.split('&code')[0];
    $scope.viewUrl = {
        'view_url': $scope.url
    };
    $scope.disableSign = true;
    GetActInfo(actId);
    getIpCount();
    $scope.isSummary = getUrlParam('summary');
    $scope.mulChoose = 0;//多票种选择逻辑
    $scope.GotoSign = function () {
        //$scope.showpromise = true;
        if (!CheckValidFieldSign() || $scope.isdisabled) return;
        if ($scope.showconderr){
            $scope.showconderr = 2;
            ShowProcover();
            return;
        }
        var extType = parseInt($scope.act.ext_type);
        if (extType == 1 || extType == 2) {
            if (!$scope.act.SignJgList || $scope.act.SignJgList.length == 0) {
                switch (extType) {
                    case 1:
                        alert('本比赛为团体比赛，请联系您的团队负责人先进行【领队报名】');
                        break;
                    case 2:
                        alert('本比赛需您的团队负责人先进行【领队报名】。');
                        break;
                }
                return;
            }
        }

        if ($scope.costNumstyle == 0) {
            alert('选择报名组别');
            return
        }
        if (IsPC() && !signextinfo) {
            signUrl = $scope.signUrl;
            ShowQrcode();
            return
        }

        if ($scope.signUrl)
            window.location.href = $scope.signUrl;

    };
    $scope.ReloadPage = function () {
        // window.location.reload();
        $scope.showconderr = 1;
        ShowProcover();
    };
    $scope.GotoSignSelect = function () {
        $(".cover").show();
        $(".showSignCover").show();
        $('body').css('overflow', 'hidden')
    }
    function IsPC() {
        var userAgentInfo = navigator.userAgent;
        var Agents = ["Android", "iPhone",
            "SymbianOS", "Windows Phone",
            "iPad", "iPod"];
        var flag = true;
        for (var v = 0; v < Agents.length; v++) {
            if (userAgentInfo.indexOf(Agents[v]) > 0) {
                flag = false;
                break;
            }
        }
        return flag;
    }
    //页面滚动-begin

    function scroll() {
        //console.log("打印log日志");实时看下效果
        console.log("开始滚动！");
    }

    var scrollFunc = function (e) {
        if ($('.actFreeTab') && $('.showSignCover') && $('.SignCover-group')) {
            if ($('.actFreeTab').offset()) {
                var actFreeTabTop = $('.actFreeTab').offset().top;

                var showSignCoverTop = $('.showSignCover').offset().top;

                var SignCovergroupH = $('.SignCover-group').height();

                e = e || window.event;
                if (e.wheelDelta) { //第一步：先判断浏览器IE，谷歌滑轮事件    
                    if (e.wheelDelta > 0) { //当滑轮向上滚动时 
                        console.log("滑轮向上滚动");
                    }
                    if (e.wheelDelta < 0) { //当滑轮向下滚动时 
                        console.log("滑轮向下滚动");
                        if (actFreeTabTop - showSignCoverTop - SignCovergroupH > 0) {
                            console.log(actFreeTabTop - showSignCoverTop - SignCovergroupH + '-----')
                        }
                    }
                } else if (e.detail) { //Firefox滑轮事件 
                    if (e.detail > 0) { //当滑轮向上滚动时 
                        console.log("滑轮向上滚动");
                    }
                    if (e.detail < 0) { //当滑轮向下滚动时 
                        console.log("滑轮向下滚动");
                    }
                }
            }
        }
    };
    //给页面绑定滑轮滚动事件 
    if (document.addEventListener) { //firefox 
        document.addEventListener('DOMMouseScroll', scrollFunc, false);
    }
    //滚动滑轮触发scrollFunc方法 //ie 谷歌 
    window.onmousewheel = document.onmousewheel = scrollFunc;


    //页面滚动-over


    $scope.GotoField = function () {
        window.location.href = 'FieldSignUp?id=' + actId + "&ind=" + $scope.costNum;
    };
    $scope.GotoLearder = function () {
        if (!CheckValidFieldSign() || $scope.isdisabled) return;
        window.location.href = 'TeamSignUp?id=' + actId + "&ind=" + $scope.costNum;
    };
    $scope.start = 0;
    $scope.CurrPage = 0;
    $scope.pagelist = [];
    $scope.togglePage = function (index) {
        //console.log('togglePage', index);
        switch (index) {
            case 0: //跳转到第一页
                $scope.CurrPage = 0;
                break;
            case -1: //上一页
                if ($scope.CurrPage > 0)
                    $scope.CurrPage--;
                break;
            case -2: //下一页
                if ($scope.CurrPage < ($scope.totalpage - 1))
                    $scope.CurrPage++;
                break;
            case -3: //跳转到最后一页
                $scope.CurrPage = $scope.totalpage - 1;
                break;
            default: //跳转第 index 页
                $scope.CurrPage = index - 1;
                break;
        }
        $scope.start = $scope.CurrPage * $scope.MaxPage;
        GetSignList();
    };
    /*获取用户点击量（点击次数）*/
    function getIpCount() {
        $http.post($scope.rootPath + '/RestPageView/PageViewCount?date=20&groupDays=30', $scope.viewUrl)
            .success(function (date) {
                $scope.pvcount = date.content.queryResult[0].pvcount;
            });
    }
    //获取当前活动的信息
    function GetActInfo(id) {
        var postData = {
            'id': id
        };
        $scope.resperr = -1;
        AddWxLoadShow(loadingToast);
        $http.post($scope.rootPath + '/RestCore/c-GetActDetail?token=&type=4', postData)
            .success(function (ret) {
                ReduceWxLoadShow(loadingToast);
                var isSuc = isSuccess(ret);
                switch (isSuc) {
                    case RET_SUCCESS:
                        $scope.resperr = 0;
                        $('.activityMain').show();
                        $('.noinfo').hide();
                        $scope.act = ret.content;
                        if ($scope.act.ActTag) {
                            // console.log($scope.act.ActTag)
                            for (var i = 0; i < $scope.act.ActTag.length; i++) {
                                if (typeof ($scope.act.ActTag[i].keywords) == 'string') {
                                    if ($scope.act.ActTag[i].keywords.indexOf("联合Q赛") != -1) {
                                        $scope.isLH = true
                                    }
                                    if ($scope.act.ActTag[i].keywords.indexOf("比赛") != -1) {
                                        $scope.isBS = true
                                    }
                                }

                            }
                        }
                        switch ($scope.act.ext_catgory) {
                            case '6':
                                if ($scope.act.act_addr) {
                                    var addrlist = JSON.parse($scope.act.act_addr);
                                    $scope.act.act_addr = '';
                                    if (addrlist) {
                                        for (var i in addrlist) {
                                            $scope.act.act_addr += addrlist[i].name + " " + ";" + " ";
                                        }
                                    }
                                }
                                GetFieldSignList();
                                break;
                            case '12':
                                if (!specialid && !signextinfo){
                                    alert("缺少证书参数，请检查！");
                                }
                                break;
                            default:
                                break;
                        }
                        if ($scope.act.summary) {
                            $scope.isSummary = true;
                        }
                        if ($scope.act.showsinglist == 1) {
                            GetSignList();
                        }
                        //跳转带微信code参数
                        $scope.TeacherUrl = '/youzi/teacher.html?id=' + $scope.act.principal +
                            '&jgid=' + $scope.act.shopid + '&code=';
                        //检查是否有讲师列表
                        if (angular.isDefined($scope.act.teacherList)) {
                            $scope.showTeacherList = true;
                            $scope.teacherList = [];
                            for (var i in $scope.act.teacherList) {
                                var tearcher = {
                                    'url': $scope.rootPath + '/ViewUserCenter/userPreview?token=&mptype=2&mpid' +
                                        $scope.act.teacherList[i].mpid,
                                    'name': $scope.act.teacherList[i].name
                                };
                                $scope.teacherList.push(tearcher);
                            }
                        }
                        // 票种选择start
                        $scope.costNum = 0;
                        $scope.costNumstyle = 1;
                        $scope.mulChoose = 0; //多票种选择逻辑
                        var tickGone = false;
                        if ($scope.act.costdetail != null && $scope.act.costdetail.length > 1) {
                            $scope.costNumstyle = 0;
                        }
                        var cansign = false;
                        var extType = parseInt($scope.act.ext_type);
                        if ($scope.act.costdetail != null && $scope.act.costdetail.length > 0) {
                            $scope.costText = $scope.act.costdetail[$scope.costNum].ticketName;
                            if ($scope.act.costdetail[$scope.costNum].ticketPrice)
                                $scope.costText += ' ' + $scope.act.costdetail[$scope.costNum].ticketPrice + '元';
                            var totalGone = 0;
                            for (var i in $scope.act.costdetail) {
                                $scope.costNum = parseInt(i);
                                var item = $scope.act.costdetail[i];
                                if (item.needsign == 1
                                    && extType == 0
                                    && item.ticketPair != 1
                                ) {
                                    cansign = true;
                                }
                                var remain = 0;
                                if (item.ticketNum == '' ||
                                    item.ticketNum == -1 ||
                                    !angular.isDefined(item.ticketSale)) {
                                    remain = 1;
                                } else {
                                    remain = item.ticketNum - item.ticketSale
                                }
                                if (remain > 0) {
                                    break;
                                }
                                totalGone++;
                            }
                            if (totalGone == $scope.act.costdetail.length) tickGone = true;
                            $scope.origroups = $scope.act.costdetail;
                            if ($scope.act.ext_catgory == '12'){
                                GetLevelByCertId(specialid);
                            }
                        }
                        // 票种选择end
                        if (parseInt($scope.act.principal) > 0)
                            $scope.showTeachUrl = true;
                        //将时间转成本地时间
                        var startmoment = GetLocalTime($scope.act.sign_starttime);
                        var endmoment = GetLocalTime($scope.act.sign_endtime);
                        $scope.act.act_starttime = GetLocalTime($scope.act.act_starttime).format('YYYY-MM-DD HH:mm:ss');
                        $scope.act.act_endtime = GetLocalTime($scope.act.act_endtime).format('YYYY-MM-DD HH:mm:ss');
                        $scope.act.sign_starttime = startmoment.format('YYYY-MM-DD HH:mm:ss');
                        $scope.act.sign_endtime = endmoment.format('YYYY-MM-DD HH:mm:ss');
                        var startTime = startmoment.valueOf();
                        var endTime = endmoment.valueOf();
                        var curr = dayjs().valueOf();
                        if (curr < startTime) {
                            if (indexType == TYPE_SCHOOL ||
                                indexType == TYPE_COMPANY ||
                                indexType == TYPE_BUYER) {
                                $scope.signCall = '未开始';
                            } else {
                                $scope.signCall = '未开始报名';
                            }
                            $scope.wxshare($scope.act);
                            return;
                        }
                        if ((curr > endTime && !cansign) || (cansign && $scope.act.isfinish == '1')) {
                            $scope.isdisabled = true;
                            if (indexType == TYPE_SCHOOL ||
                                indexType == TYPE_COMPANY ||
                                indexType == TYPE_BUYER) {
                                $scope.signCall = '已结束';
                            } else {
                                $scope.signCall = '报名结束';
                            }
                            $scope.wxshare($scope.act);
                            return;
                        }
                        $scope.wxshare($scope.act);
                        if (parseInt($scope.act.act_total) > 0 &&
                            parseInt($scope.act.act_total) <= parseInt($scope.act.act_sign)) {
                            $scope.signCall = '名额已满';
                            return;
                        }
                        if (tickGone) {
                            $scope.signCall = '票已售罄';
                            return;
                        }
                        $scope.disableSign = false;
                        // $scope.signStyle = { 'background': '#61b72b' };
                        $scope.signStyle = {
                            'background': 'linear-gradient(172deg,rgba(146,234,88,1),rgba(100,184,44,1))'
                        }
                        SetEntryUrl();
                        switch (indexType) {
                            case TYPE_SCHOOL:
                                $scope.signCall = '受赠申请';
                                break;
                            case TYPE_COMPANY:
                                $scope.signCall = '厂商入驻';
                                break;
                            case TYPE_BUYER:
                                $scope.signCall = '买家入驻';
                                break;
                            default:
                                $scope.signCall = '报名'; //我要报名
                                if ($scope.act.sign_bttext) {
                                    $scope.signCall = $scope.act.sign_bttext;
                                }
                                if ($scope.act.ext_catgory == 4) {
                                    $scope.signCall = '【上传等级证】';
                                }
                                if ($scope.act.ext_catgory == 6){
                                    $scope.signField = '场地合作';
                                }
                                switch (extType) {
                                    case 1:
                                    case 2:
                                        if (!signjgid)
                                            $scope.signLearder = '领队报名';
                                        break;
                                }
                                switch (parseInt($scope.act.id)) {
                                    case 2587:
                                        $scope.signCall = '申请团购';
                                        break;
                                }
                                break;

                        }

                        break;
                    default:
                        $('.activityMain').hide();
                        $('.noinfo').show();
                        break;
                }
            })
            .error(function () {
                ReduceWxLoadShow(loadingToast);
                $('.activityMain').hide();
                $('.noinfo').show();
            });

    }

    // $(function () {
    //     $('#doc-dropdown-js').dropdown({justify: '#doc-dropdown-justify-js'});
    // });
    $scope.isChooseCost = function (i) {
        return $scope.mulChoose & (1 << i);
    };
    //票种选择
    var curr_choose = 0;
    $scope.selectCost = function (e, detail) {
        if ((detail.ticketNum - detail.ticketSale) <= 0 &&
            detail.ticketNum != '' &&
            detail.ticketNum != -1
        ) {
            return;
        } else {
            var i = e.$parent.$index;
            if (currgroupindex >= 0 && $scope.act.ext_catgory > 0 && i != currgroupindex){
                //已报名的分组并且不是默认活动的多选逻辑
                var msg = "您已报名：" + $scope.act.costdetail[currgroupindex].ticketName
                    + "，确认切换为：" + detail.ticketName
                    + "吗？";
                if (confirm(msg)){
                    ChangeGroupIndex(i, detail);
                }
            }else{
                ChangeGroupIndex(i, detail);
            }
        }

    };
    // 微信分享链接信息
    $scope.wxshare = function (act) {
        // console.log(act);
        AddWxLoadShow(loadingToast);
        var tags = act.ActTag, jns = false;
        for (var i = 0; i < tags.length; i++) {
            if (tags[i].keywords == '挑战吉尼斯') {
                jns = true;
            }
        }
        $http.get($scope.rootPath + '/RestIndex/getSignPackage?signUrl=' +
            encodeURIComponent(window.location.href.split('#')[0]) +
            '&code=&openId=' + openId)
            .success(function (ret) {
                ReduceWxLoadShow(loadingToast);
                var isSuc = isSuccess(ret);
                switch (isSuc) {
                    case RET_SUCCESS:
                        $scope.wx_share = ret.content;
                        var openId = $scope.wx_share.openId;
                        if (!openId) openId = '';
                        if (!$scope.disableSign) {
                            SetEntryUrl();
                        }
                        if (jns) {
                            act.shareTitle = `来吧，和${$scope.wx_share.nickname}老师一起冲击国象吉尼斯世界记录！`
                        } else {
                            act.shareTitle = act.title;

                        }
                        act.sharePoster = act.poster;
                        CheckHasSign($scope.wx_share.openId);
                        wx.config({
                            debug: false, // 开启调试模式,调用的所有api的返回值会在客户端alert出来，若要查看传入的参数，可以在pc端打开，参数信息会通过log打出，仅在pc端时才会打印。
                            appId: $scope.wx_share.appId, // 必填，公众号的唯一标识
                            timestamp: $scope.wx_share.timestamp, // 必填，生成签名的时间戳
                            nonceStr: $scope.wx_share.nonceStr, // 必填，生成签名的随机串
                            signature: $scope.wx_share.signature, // 必填，签名，见附录1
                            jsApiList: ['updateAppMessageShareData', 'updateTimelineShareData'
                                , 'onMenuShareQQ', 'scanQRCode'
                                ,'onMenuShareAppMessage','onMenuShareTimeline'] // 必填，需要使用的JS接口列表，所有JS接口列表见附录2
                        });
                        var shareDesc = act.share_desc;
                        $scope.url = window.location.href.split('&code')[0];
                        $scope.url = DelUrlParam($scope.url, 'jwttoken');
                        $scope.url = DelUrlParam($scope.url, 'token');
                        if (openId.length > 0) {
                            $scope.url = DelUrlParam($scope.url, 'shareID');

                            $scope.url += "&shareID=" + openId;
                            if ($scope.wx_share.dividedauth) {
                                $scope.url = DelUrlParam($scope.url, 'divideID');
                                $scope.url += "&divideID=" + openId
                            }
                        }
                        if (!shareDesc) {
                            shareDesc = act.shoptitle + '　' + act.act_addr;
                        }
                        var poster = 'https://scdn.kaisaile.org/gximgs/hdposters/default.jpg';
                        if (act.sharePoster && act.sharePoster.length > 0) {
                            poster = act.sharePoster;
                        }
                        wx.ready(function () {
                            wx.checkJsApi({
                                jsApiList: ['updateAppMessageShareData', 'updateTimelineShareData'
                                    , 'onMenuShareQQ', 'scanQRCode'
                                ,'onMenuShareAppMessage','onMenuShareTimeline'], // 需要检测的JS接口列表，所有JS接口列表见附录2,
                                success: function (res) {
                                    console.log('wx.checkJsApi', res)
                                }
                            });
                            // 自定义“分享给朋友”及“分享到QQ”按钮的分享内容
                            wx.updateAppMessageShareData({
                                title: act.shareTitle, // 分享标题
                                desc: shareDesc, // 分享描述
                                link: $scope.url,
                                imgUrl: poster, // 分享图标
                                success: function (res) {
                                    console.log('success wx.updateAppMessageShareData', res);
                                }
                                //,trigger : function(res){
                                //    alert('trigger wx.updateAppMessageShareData', res);
                                //}
                            });
                            /*自定义“分享到朋友圈”及“分享到QQ空间”按钮的分享内容*/
                            wx.updateTimelineShareData({
                                title: act.shareTitle, // 分享标题
                                desc: shareDesc, // 分享描述
                                link: $scope.url, // 分享链接
                                imgUrl: poster, // 分享图标
                                success: function (res) {
                                    console.log('success wx.updateTimelineShareData', res)
                                }
                                //,trigger : function(res){
                                //    alert('trigger wx.updateTimelineShareData', res);
                                //}
                            });
                        });
                        break;
                    default:
                        if ($scope.token){
                            CheckHasSign(openId);
                        }
                        break;
                }
            })
            .error(function () {
                ReduceWxLoadShow(loadingToast);
            });
    };
    //显示默认名片
    $scope.ShowUserMp = function (tel) {
        AddWxLoadShow(loadingToast);
        $http.post($scope.rootPath + '/RestIndex/GetMpShowDefault?tel=' + tel)
            .success(function (ret) {
                ReduceWxLoadShow(loadingToast);
                if (isSuccess(ret) == RET_SUCCESS) {
                    var mpid = ret.content;
                    if (mpid) {
                        OpenNewWindow($scope.rootPath + '/ViewUserCenter/userPreview?token=&mptype=2&mpid=' + mpid);
                    }
                }
            })
            .error(function () {
                ReduceWxLoadShow(loadingToast);
            });
    };
    $scope.ClickCondErr = function (onecond) {
        $scope.showconderr = 1;
        ShowProcover();
        switch (onecond.hdid){
            case -110: //未实名认证
                if (IsWeiXinAgent()) {
                    wx.miniProgram.getEnv(function(res) {
                        if (res.miniprogram) {
                            // 走在小程序的逻辑
                            ConfirmAuth({
                                title: '此赛事需先实名认证。',
                                sure: '立即认证',
                                cancel: '取消'
                            }, function() {
                                wx.miniProgram.navigateTo({ url: '/pages/auth/auth?trustTel=' + $scope.signtel});
                            });

                        }else{
                            Jump2UserAuth();
                        }
                    });
                }else{
                    Jump2UserAuth();
                }
                break;
            case -112://需要棋力认证
                if (IsWeiXinAgent()) {
                    wx.miniProgram.getEnv(function(res) {
                        if (res.miniprogram) {
                            // 走在小程序的逻辑
                            ConfirmAuth({
                                title: '您的棋力水平不符合当前组别的报名条件。',
                                sure: '立即认证',
                                cancel: '取消'
                            }, function() {
                                wx.miniProgram.navigateTo({ url: '/pages/elo-auth/elo-auth?trustTel=' + $scope.signtel });
                            });
                        }else{
                            Jump2UserLevelAuth();
                        }
                    });
                }else{
                    Jump2UserLevelAuth();
                }
                break;
            default://普通错误，跳转报名页面
                ConfirmAuth({
                    title: '您存在不满足当前组别的报名条件。',
                    sure: '立即修改',
                    cancel: '取消'
                }, function() {
                    window.location.href = $scope.signUrl;
                });
                break;
        }
    };
    //通过微信号判断是否报过名
    function CheckHasSign(openId) {
        hassigngroupid = null;
        if (openId || $scope.token) {
            AddWxLoadShow(loadingToast);
            $http.post($scope.rootPath + '/Education/HasOpenidSign'
                , { 'openid': openId, 'hdid': actId, 'ticketid': $scope.act.costdetail[$scope.costNum].ticketId
            , 'token' : $scope.token})
                .success(function (ret) {
                    ReduceWxLoadShow(loadingToast);
                    $scope.signgroupname = "";
                    var retSuc = isSuccess(ret);
                    if (RET_SUCCESS == retSuc && ret.content) {
                        hassigngroupid = ret.content.ticketid;
                        if ($scope.act.costdetail){
                            for (var index in $scope.act.costdetail){
                                if (ret.content.ticketid == $scope.act.costdetail[index].ticketId){
                                    $scope.costNum = index;
                                    $scope.realindex = index;
                                    $scope.costNumstyle = 1;
                                    $scope.signgroupname = $scope.act.costdetail[index].ticketName;
                                    currgroupindex = index;
                                    SetEntryUrl();
                                    break;
                                }
                            }
                        }
                        if (!$scope.isdisabled){
                            $scope.signCall = '已报名（点击进入修改）';
                            $scope.showconderr = 0;//是否显示失败详情对话框
                            if (ret.content.condlevel != '0' && ret.content.condlevel != '1'){
                                $scope.signCall = '报名未完成（点击查看详情）';
                                $scope.showconderr = 1;
                                $scope.signtel = ret.content.tel;
                                if (ret.content.condmsg){
                                    $scope.conderrlist = JSON.parse(ret.content.condmsg);
                                }
                            }
                            ShowProcover();
                        }
                    }
                })
                .error(function () {
                    ReduceWxLoadShow(loadingToast);
                });
        }
    }

    function GetSignList() {
        $scope.signList = [];
        $scope.showPage = false;
        AddWxLoadShow(loadingToast);
        $http.post($scope.rootPath + '/Education/c-GetSignList?token=' +
            '&start=' + $scope.start, {
            'hdid': actId,
            'exam': 1,
        })
            .success(function (ret) {
                ReduceWxLoadShow(loadingToast);
                var retSuc = isSuccess(ret);
                switch (retSuc) {
                    case RET_SUCCESS:
                        var details = ret.content.Details;
                        if (details && details.length > 0) {
                            for (var i = 0; i < ret.content.costdetail.costdetail.length; i++) {
                                $scope.signList[i] = {
                                    groupName: ret.content.costdetail.costdetail[i].ticketName,
                                    groupArr: []
                                };
                                for (var j = 0; j < details.length; j++) {
                                    if (details[j].newgroup == $scope.signList[i].groupName) {
                                        $scope.signList[i].groupArr.push(details[j])
                                    }

                                }
                            }


                            $scope.showPage = true;
                            SetPageState($scope, ret.content.Total, ret.content.MaxPage);
                        } else {
                            $scope.showPage = false;
                            $scope.signList = []
                        }

                        break;
                }
                AddWxLoadShow(loadingToast);
                $http.post($scope.rootPath + '/RestYbUserManage/event_Summary?token=' +
                    '&start=' + $scope.start, {
                    'hdid': actId
                })
                    .success(function (ret) {
                        ReduceWxLoadShow(loadingToast);
                        $scope.cont = ret.content;
                    })
                    .error(function () {
                        ReduceWxLoadShow(loadingToast);
                    });
            })
            .error(function () {
                ReduceWxLoadShow(loadingToast);
            });
    }
    //通过证书编号查询当前证书的棋力等级
    function GetLevelByCertId(id) {
        $scope.act.costdetail = [];
        if (id){
            AddWxLoadShow(loadingToast);
            $http.get($scope.rootPath + '/Education/GetLevelByCertId?id=' + id)
                .success(function (ret) {
                    ReduceWxLoadShow(loadingToast);
                    var retSuc = isSuccess(ret);
                    switch (retSuc) {
                        case RET_SUCCESS:
                            certlevel = ret.content;
                            if ($scope.origroups){
                                for (var costdetail of $scope.origroups){
                                    if (costdetail.authlevel == certlevel){
                                        $scope.act.costdetail.push(costdetail);
                                    }
                                }
                            }
                            break;
                    }
                })
                .error(function () {
                    ReduceWxLoadShow(loadingToast);
                });
        }else if (signextinfo){
            AddWxLoadShow(loadingToast);
            $http.post($scope.rootPath + "/RestGxService/checkSignExtInfo", {SignExtInfo:signextinfo})
                .success(function(ret) {
                    ReduceWxLoadShow(loadingToast);
                    if (isSuccess(ret) == RET_SUCCESS) {
                        certlevel = ret.content.prolevel;
                        if ($scope.origroups){
                            for (var costdetail of $scope.origroups){
                                if (costdetail.authlevel == certlevel){
                                    $scope.act.costdetail.push(costdetail);
                                }
                            }
                        }
                    }
                })
                .error(function () {
                    ReduceWxLoadShow(loadingToast);
                });
        }

    }
    function SetEntryUrl() {
        $scope.signUrl = 'entry?id=' + actId +
            '&st=' + indexType
            + '&ind=' + $scope.realindex;
        if (signjgid) {
            $scope.signUrl += '&jgid=' + signjgid;
        }
        if (fromopenid) {
            $scope.signUrl += '&from=' + fromopenid;
        }
        if (sharemd5) {
            $scope.signUrl += '&sharemd5=' + sharemd5;
        }
        if (sharejgid) {
            $scope.signUrl += '&sharejg=' + sharejgid;
        }
        if (fieldid){
            $scope.signUrl += '&fieldid=' + fieldid;
        }
        if(specialid){
            $scope.signUrl += '&local_id=' + specialid;
        }
        //多票种参数
        if ($scope.mulChoose > 0) {
            $scope.signUrl += '&mulind=' + $scope.mulChoose;
        }
        if (nexturl) {
            $scope.signUrl += '&nexturl=' + encodeURIComponent(nexturl);
        }
        if (jwttoken || $scope.token) {
            if ($scope.token){
                $scope.signUrl += '&jwttoken=' + $scope.token;
            }else{
                $scope.signUrl += '&jwttoken=' + jwttoken;
            }
        }
        if (signextinfo){
            $scope.signUrl += '&signextinfo=' + signextinfo;
        }
    }
    function GetFieldSignList() {
        $http.post($scope.rootPath + '/RestCore/GetFieldSignList?token=&hdid=' + actId, {authflag:1})
            .success(function(ret) {
                if (ret.data && ret.data.length > 0) {
                    $scope.fieldlist = ret.data;
                }
            })
    }
    function CheckValidFieldSign(){
        if ($scope.act.ext_catgory == '6'){
            //区块赛需要有场地报名并且审核通过
            if (!$scope.fieldlist){
                alert('本比赛为区块赛，需有场地后才能进行活动报名！');
                return false;
            }
        }
        return true;
    }
    function ChangeGroupIndex(i, detail) {
        choosegroupid = detail.ticketId;
        $scope.costNumstyle = 1;
        $scope.costNum = i;
        $scope.realindex = $scope.costNum;
        if ($scope.origroups && $scope.act.ext_catgory == 12){
            for (var pos in $scope.origroups){
                if ($scope.origroups[pos].ticketId == detail.ticketId){
                    $scope.realindex = pos;
                    break;
                }
            }
        }
        $scope.costText = detail.ticketName + ' ' + detail.ticketPrice + '元';
        if ($scope.act.ext_catgory == 0) {
            if ($scope.isChooseCost(i)) {
                $scope.mulChoose &= ~(1 << i);
                curr_choose--;
            } else {
                var limit_total = parseInt($scope.act.act_total);
                var curr_sign = parseInt($scope.act.act_sign);
                if (limit_total > 0) {
                    var curr_total = curr_sign + curr_choose;
                    if (curr_total >= limit_total) {
                        alert("已达报名人数上限！");
                        return;
                    }
                }
                $scope.mulChoose |= (1 << i);
                curr_choose++;
            }
        }
        // $('#doc-dropdown-js').dropdown('close');
        SetEntryUrl();
        if (hassigngroupid){
            if (hassigngroupid != choosegroupid){
                $scope.signCall = '切换分组（点击进入修改）';
            }else{
                $scope.signCall = '报名未完成（点击查看详情）';
            }
        }
    }
    function ConfirmAuth(str, click) {
        $scope.showconderr = 1;
        ShowProcover();
        var confirmFram = document.createElement("DIV");
        confirmFram.id = "confirmFram";
        confirmFram.style.position = "fixed";
        confirmFram.style.right = "0";
        confirmFram.style.bottom = "0";
        confirmFram.style.left = "0";
        confirmFram.style.top = "0";
        confirmFram.style.textAlign = "center";
        confirmFram.style.lineHeight = "150px";
        confirmFram.style.zIndex = "9999";
        confirmFram.style.backgroundColor = "rgba(0, 0, 0, 0.58)";
        confirmFram.style.fontSize = "12px";
        strHtml = '<ul class="confirm_ul">';
        strHtml += '<li class="confirm_content">' + str.title + '</li>';
        strHtml += '<li class="confirm_btn-wrap"><a type="button" value="' + str.cancel + '" onclick="doFalse()" class="confirm_btn">' + str.cancel + '</a><a type="button" value="' + str.sure + '" onclick="doOk()" class="confirm_btn">' + str.sure + '</a></li>';
        strHtml += '</ul>';
        confirmFram.innerHTML = strHtml;
        document.body.appendChild(confirmFram);
        this.doOk = function() {
            confirmFram.style.display = "none";
            if (typeof click == "function") {
                click();
                return true;
            }

        };
        this.doFalse = function() {
            confirmFram.style.display = "none";
            if (typeof click == "function") {
                return false;
            }

        }
    }
    function Jump2UserAuth(){
        ConfirmAuth({
            title: '此赛事需先实名认证。',
            sure: '立即认证',
            cancel: '取消'
        }, function() {
            window.location.href = $scope.rootPath + '/WxViews/actindex?id=2';
        });
    }
    function Jump2UserLevelAuth(){
        ConfirmAuth({
            title: '您的棋力水平不符合当前组别的报名条件。',
            sure: '立即认证',
            cancel: '取消'
        }, function() {
            window.location.href = $scope.rootPath + '/WxViews/actindex?id=1248';
        });
    }
    function ShowProcover() {
        $('.procover').hide();
        if (hassigngroupid && choosegroupid && hassigngroupid != choosegroupid){
            //切换分组了，直接报名
            window.location.href = $scope.signUrl;
            return;
        }
        if ($scope.showconderr == 2){
            $('.procover').show();
        }
    }
});
app.filter('modality', function () { //可以注入依赖
    return function (text) {
        console.log(text == 1)
        if (text == 1) {
            return '线上赛事'
        }
        if (text == 2) {
            return '线下赛事'
        }
        if (text == 0) {
            return '普通活动'
        }
        if (text == 6) {
            return '区块赛'
        }
        if (text == 7) {
            return '线上约战赛'
        }
        if (text == 11) {
            return '线下认证赛'
        }
        return ''
    }
});

app.filter('to_trusted', ['$sce', function ($sce) {
    return function (text) {
        return $sce.trustAsHtml(text);
    };
}]);
app.filter('timefil', ['$sce', function ($sce) {
    return function (text) {
        if (text) {
            var string = text.substr(5); //删除第一个字符
            string = string.substr(0, string.length - 3);
            return string
        } else {
            return ''
        }

    };
}]);