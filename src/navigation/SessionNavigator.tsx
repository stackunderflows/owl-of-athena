import * as React from "react";
import { Platform } from "react-native";
import {
    NavigationParams,
    NavigationRoute,
    NavigationRouteConfigMap
    //NavigationScreenConfigProps
} from "react-navigation";
import {
    createStackNavigator,
    HeaderBackButtonProps,
    NavigationStackOptions,
    NavigationStackProp
} from "react-navigation-stack";

import { HeaderBackButton } from "../components";
import { Dimens, Message, Colors } from "../constants";
import { SessionListScreen, SessionScreen } from "../screens";
import { CommonStyles } from "../styles";

const routeConfigMap: NavigationRouteConfigMap<
    NavigationStackOptions,
    NavigationStackProp<NavigationRoute<NavigationParams>, any>
> = {
    List: {
        path: "",
        screen: SessionListScreen,
        navigationOptions: {
            headerLeft: undefined,
            headerTitle: Message.get("session_list_title"),
            headerTitleContainerStyle: {
                ...CommonStyles.headerTitleContainerStyle,
                marginLeft: Dimens.content_margin_horizontal
            }
        }
    },
    Detail: {
        path: "",
        screen: SessionScreen
    }
};

const SessionNavigator = createStackNavigator(routeConfigMap, {
    defaultNavigationOptions: () =>
        /*configProps: NavigationScreenConfigProps<
            NavigationStackProp<NavigationRoute<NavigationParams>>
        >*/
        {
            return {
                headerLeft: (props: HeaderBackButtonProps) => (
                    <HeaderBackButton {...props} />
                ),
                headerTintColor: Colors.cyan,
                headerStyle: CommonStyles.headerStyle,
                headerTitleContainerStyle:
                    CommonStyles.headerTitleContainerStyle,
                headerLeftContainerStyle: CommonStyles.headerLeftContainerStyle
            };
        },
    headerMode: Platform.OS === "web" ? "screen" : "float",
    initialRouteName: "List"
});

export default SessionNavigator;
