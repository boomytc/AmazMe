const root = await (await fetch("/events.schema.json")).json();
export function validate(value, schema=root) {
  if(schema.$ref)return validate(value,root.$defs[schema.$ref.split("/").at(-1)]);
  if(schema.anyOf)return schema.anyOf.some(option=>validate(value,option));
  if(schema.enum&&!schema.enum.includes(value))return false;
  if(schema.type==="null")return value===null;
  if(schema.type==="string")return typeof value==="string";
  if(schema.type==="integer")return Number.isSafeInteger(value);
  if(schema.type==="number")return typeof value==="number"&&Number.isFinite(value);
  if(schema.type==="boolean")return typeof value==="boolean";
  if(schema.type==="array")return Array.isArray(value)&&value.every(item=>validate(item,schema.items));
  if(schema.type==="object") {
    if(!value||typeof value!=="object"||Array.isArray(value))return false;
    if((schema.required||[]).some(key=>!Object.hasOwn(value,key)))return false;
    return Object.entries(value).every(([key,item])=>schema.properties[key]?validate(item,schema.properties[key]):schema.additionalProperties!==false);
  }
  return false;
}
