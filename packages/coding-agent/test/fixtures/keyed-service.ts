import { method, remote, type RemoteContract } from "@amazme/chord";
import { Type, type TObject, type TString, type TNull } from "typebox";

type ProbeContract = RemoteContract<{
 version: 1;
 input: TObject<{ key: TString }>;
 variants: { default: {
  state: { state: TObject<{ value: TString }> };
  methods: { replace: ReturnType<typeof method<TString, TNull>>; wait: ReturnType<typeof method<TNull, TNull>> };
 } };
}>;
export const KeyedProbe: ProbeContract = remote("test.keyed-probe", {
 version: 1, input: Type.Object({ key: Type.String() }),
 variants: { default: {
  state: { state: Type.Object({ value: Type.String() }) },
  methods: { replace: method(Type.String(), Type.Null()), wait: method(Type.Null(), Type.Null()) },
 } },
});
