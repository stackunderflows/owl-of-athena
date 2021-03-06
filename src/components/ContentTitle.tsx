import React, { FunctionComponent } from "react";
import { Text, StyleSheet, TextStyle } from "react-native";
import { Message, Colors, Dimens, Fonts } from "../constants";
import { MessageLocalizationParam } from "../constants/Message";
type ContentTitleProps = {
    children: MessageLocalizationParam;
    style?: TextStyle;
};
export const ContentTitle: FunctionComponent<ContentTitleProps> = (
    props: ContentTitleProps
) => {
    return (
        <Text style={createTextStyle(props.style)}>
            {Message.get(props.children.key, props.children.restParam)}
        </Text>
    );
};

const textStyle: TextStyle = {
    color: Colors.cyan,
    fontFamily: Fonts.primaryRegular,
    fontSize: Dimens.content_title_text_size,
    marginTop: Dimens.content_title_margin_top,
    marginBottom: Dimens.content_title_margin_bottom
};
function createTextStyle(propsStyle?: TextStyle): TextStyle {
    return StyleSheet.flatten([propsStyle, textStyle]);
}
